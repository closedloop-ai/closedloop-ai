import type { ApiResult, JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  DesktopCommandEvent,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";

const RESULT_STREAM_TIMEOUT_MS = 120_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 300_000;
const STREAM_POLL_INTERVAL_MS = 1000;

export type RelayEncodedBody =
  | { kind: "none" }
  | { kind: "json"; value: JsonValue }
  | { kind: "text"; value: string; contentType: string | null }
  | { kind: "base64"; value: string; contentType: string | null };

export type RelayHttpRequestPayload = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: RelayEncodedBody;
};

type RelayResponseEnvelope = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export class RelayRequestError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = "RelayRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRelayResponseEnvelope(
  value: unknown
): RelayResponseEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  // Electron gateway uses { statusCode, data }, relay envelope uses { status, body }.
  const status =
    typeof value.status === "number"
      ? value.status
      : typeof value.statusCode === "number"
        ? value.statusCode
        : undefined;
  const body =
    "body" in value ? value.body : "data" in value ? value.data : undefined;

  if (status === undefined || body === undefined) {
    return null;
  }

  return {
    status,
    body,
    headers:
      isRecord(value.headers) &&
      Object.values(value.headers).every((entry) => typeof entry === "string")
        ? (value.headers as Record<string, string>)
        : undefined,
  };
}

async function parseApiResult<T>(response: Response): Promise<T> {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResult<T> | null;

  if (!response.ok) {
    if (payload && !payload.success) {
      throw new RelayRequestError(payload.error, response.status, payload);
    }
    throw new RelayRequestError(
      `Relay API request failed (${response.status})`,
      response.status
    );
  }

  if (!payload?.success) {
    throw new RelayRequestError(
      "Relay API returned an invalid response envelope",
      502,
      payload
    );
  }

  return payload.data;
}

async function* readSseData(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length > 0) {
        yield dataLines.join("\n");
      }

      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  // Flush decoder and yield any trailing SSE event without a terminating \n\n
  buffer += decoder.decode();
  const remaining = buffer.trim();
  if (remaining) {
    const dataLines = remaining
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  }
}

async function parseStreamError(
  response: Response
): Promise<RelayRequestError> {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResult<unknown> | null;

  if (payload && !payload.success) {
    return new RelayRequestError(payload.error, response.status, payload);
  }

  return new RelayRequestError(
    `Relay result stream failed (${response.status})`,
    response.status
  );
}

async function parsePollError(response: Response): Promise<RelayRequestError> {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiResult<unknown> | null;

  if (payload && !payload.success) {
    return new RelayRequestError(payload.error, response.status, payload);
  }

  return new RelayRequestError(
    `Relay event poll failed (${response.status})`,
    response.status,
    payload
  );
}

function isEventTerminal(event: DesktopCommandEvent): boolean {
  if (event.eventType === "done") {
    return true;
  }
  return (
    (event.eventType === "error" || event.eventType === "result") &&
    isRecord(event.data) &&
    event.data.terminal === true
  );
}

function isTerminalErrorEvent(event: DesktopCommandEvent): boolean {
  return (
    event.eventType === "error" &&
    isRecord(event.data) &&
    event.data.terminal === true
  );
}

function extractTerminalError(event: DesktopCommandEvent): string {
  if (isRecord(event.data) && typeof event.data.error === "string") {
    return event.data.error;
  }
  return "Relay command failed";
}

/** Parse "gateway returned 404: {...}" → 404, or null if not a gateway HTTP error. */
function extractGatewayStatus(event: DesktopCommandEvent): number | null {
  const msg =
    isRecord(event.data) && typeof event.data.error === "string"
      ? event.data.error
      : "";
  const match = /^gateway returned (\d{3})/.exec(msg);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function extractGatewayBody(event: DesktopCommandEvent): unknown {
  const msg =
    isRecord(event.data) && typeof event.data.error === "string"
      ? event.data.error
      : "";
  const colonIdx = msg.indexOf(": ");
  if (colonIdx === -1) {
    return { error: msg };
  }
  const jsonStr = msg.slice(colonIdx + 2);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return { error: jsonStr };
  }
}

function makeCommandEventsStreamUrl(
  apiOrigin: string,
  targetId: string,
  commandId: string
): string {
  return `${apiOrigin}/compute-targets/${encodeURIComponent(targetId)}/commands/${encodeURIComponent(commandId)}/events?stream=true`;
}

function normalizeMethod(method: string): CreateDesktopCommandInput["method"] {
  const normalized = method.toUpperCase();
  if (
    normalized === "GET" ||
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported relay method: ${method}`);
}

function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  const url = new URL(pathWithQuery, "http://relay.local");
  const query = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const values = query.get(key) ?? [];
    values.push(value);
    query.set(key, values);
  }

  if (query.size === 0) {
    return { path: url.pathname };
  }

  return {
    path: url.pathname,
    query: Object.fromEntries(
      Array.from(query.entries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    ),
  };
}

function unwrapRelayBody(body: RelayEncodedBody): JsonValue | undefined {
  switch (body.kind) {
    case "none":
      return undefined;
    case "json":
      return body.value as JsonValue;
    case "text":
      return body.value as unknown as JsonValue;
    case "base64":
      return body.value as unknown as JsonValue;
  }
}

function toDesktopCommandInput(
  operationId: string,
  request: RelayHttpRequestPayload,
  streaming: boolean
): CreateDesktopCommandInput {
  const { path, query } = splitPathAndQuery(request.path);
  if (!path.startsWith("/api/engineer/")) {
    throw new Error(`Relay path must target /api/engineer/*, got: ${path}`);
  }

  return {
    operationId,
    method: normalizeMethod(request.method),
    path,
    headers: request.headers,
    query,
    body: unwrapRelayBody(request.body),
    streaming,
  };
}

function mapCommandEventToNdjsonLine(
  event: DesktopCommandEvent
): Record<string, unknown> {
  const line: Record<string, unknown> = isRecord(event.data)
    ? { ...event.data }
    : { value: event.data };

  if (typeof line.type !== "string") {
    const hasContent =
      Object.hasOwn(line, "content") && line.content !== undefined;
    line.type =
      event.eventType === "chunk" && hasContent ? "text" : event.eventType;
  }

  return line;
}

export function isStreamingEngineerRequest(
  method: string,
  path: string,
  acceptHeader: string | null
): boolean {
  if (acceptHeader?.includes("text/event-stream")) {
    return true;
  }
  if (method.toUpperCase() !== "POST") {
    return false;
  }

  const pathname = path.split("?")[0];
  return [
    /^\/api\/engineer\/symphony\/chat\/[^/]+$/,
    /^\/api\/engineer\/symphony\/comment-chat\/[^/]+$/,
    /^\/api\/engineer\/codex\/chat\/[^/]+$/,
    /^\/api\/engineer\/codex\/argue\/[^/]+$/,
    /^\/api\/engineer\/codex\/review\/[^/]+$/,
    /^\/api\/engineer\/codex\/finding-chat\/[^/]+$/,
    /^\/api\/engineer\/ticket-chat$/,
    /^\/api\/engineer\/terminal-chat$/,
    /^\/api\/engineer\/run-viewer-chat$/,
  ].some((pattern) => pattern.test(pathname));
}

export class RelayClient {
  private readonly apiOrigin: string;
  private authToken: string;
  private readonly internalApiSecret?: string;
  private refreshToken?: () => Promise<string | null>;

  constructor(
    apiOrigin: string,
    authToken: string,
    internalApiSecret?: string
  ) {
    this.apiOrigin = apiOrigin;
    this.authToken = authToken;
    this.internalApiSecret = internalApiSecret;
  }

  setRefreshToken(fn: () => Promise<string | null>): void {
    this.refreshToken = fn;
  }

  private async createCommand(
    targetId: string,
    input: CreateDesktopCommandInput
  ): Promise<CreateDesktopCommandResponse> {
    const response = await fetch(
      `${this.apiOrigin}/compute-targets/${encodeURIComponent(targetId)}/commands`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(input),
      }
    );

    return parseApiResult<CreateDesktopCommandResponse>(response);
  }

  private async openCommandEventsStream(
    targetId: string,
    commandId: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const response = await fetch(
      makeCommandEventsStreamUrl(this.apiOrigin, targetId, commandId),
      {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.authToken}`,
        },
        signal,
      }
    );

    if (!response.ok) {
      throw await parseStreamError(response);
    }

    return response;
  }

  async executeOperation(
    targetId: string,
    request: RelayHttpRequestPayload
  ): Promise<{ envelope: RelayResponseEnvelope | null; value: unknown }> {
    const operationId = crypto.randomUUID();
    const commandInput = toDesktopCommandInput(operationId, request, false);
    const { commandId } = await this.createCommand(targetId, commandInput);

    const abortController = new AbortController();
    let timeout = setTimeout(
      () => abortController.abort(),
      RESULT_STREAM_TIMEOUT_MS
    );
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => abortController.abort(),
        RESULT_STREAM_TIMEOUT_MS
      );
    };

    try {
      const response = await this.openCommandEventsStream(
        targetId,
        commandId,
        abortController.signal
      );

      for await (const payload of readSseData(response)) {
        resetTimeout();
        const event = JSON.parse(payload) as DesktopCommandEvent;
        if (isTerminalErrorEvent(event)) {
          // Gateway HTTP errors (e.g. 404) should be forwarded as
          // responses, not thrown as exceptions that become 502s.
          const gatewayStatus = extractGatewayStatus(event);
          if (gatewayStatus !== null) {
            const errorBody = extractGatewayBody(event);
            return {
              envelope: { status: gatewayStatus, body: errorBody },
              value: { statusCode: gatewayStatus, data: errorBody },
            };
          }
          throw new Error(extractTerminalError(event));
        }

        const line = mapCommandEventToNdjsonLine(event);

        if (event.eventType === "result") {
          return {
            envelope: parseRelayResponseEnvelope(line),
            value: line,
          };
        }

        if (isEventTerminal(event)) {
          return {
            envelope: parseRelayResponseEnvelope(line),
            value: line,
          };
        }
      }
    } finally {
      clearTimeout(timeout);
      abortController.abort();
    }

    throw new Error("Relay result stream ended without a terminal event");
  }

  private async pollCommandEvents(
    targetId: string,
    commandId: string
  ): Promise<DesktopCommandEvent[]> {
    const useInternalRoute =
      typeof this.internalApiSecret === "string" &&
      this.internalApiSecret.length > 0;
    const url = useInternalRoute
      ? `${this.apiOrigin}/internal/compute-targets/${encodeURIComponent(targetId)}/commands/${encodeURIComponent(commandId)}/events`
      : `${this.apiOrigin}/compute-targets/${encodeURIComponent(targetId)}/commands/${encodeURIComponent(commandId)}/events`;
    let response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        ...(useInternalRoute
          ? { "x-internal-secret": this.internalApiSecret }
          : { Authorization: `Bearer ${this.authToken}` }),
      },
    });

    if (!response.ok) {
      if (response.status === 401 && this.refreshToken && !useInternalRoute) {
        let newToken: string | null = null;
        try {
          newToken = await this.refreshToken();
        } catch {
          throw await parsePollError(response);
        }
        if (!newToken) {
          throw await parsePollError(response);
        }
        this.authToken = newToken;
        const retryResponse = await fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: { Authorization: `Bearer ${this.authToken}` },
        });
        if (!retryResponse.ok) {
          throw await parsePollError(retryResponse);
        }
        response = retryResponse;
      } else {
        throw await parsePollError(response);
      }
    }

    const payload = (await response.json().catch(() => null)) as ApiResult<
      DesktopCommandEvent[]
    > | null;
    if (!payload?.success) {
      throw new RelayRequestError(
        "Relay event poll returned an invalid response envelope",
        502,
        payload
      );
    }
    return payload.data;
  }

  async streamOperation(
    targetId: string,
    request: RelayHttpRequestPayload
  ): Promise<ReadableStream<Uint8Array>> {
    const operationId = crypto.randomUUID();
    const commandInput = toDesktopCommandInput(operationId, request, true);
    const { commandId } = await this.createCommand(targetId, commandInput);

    const encoder = new TextEncoder();
    const self = this;

    // Poll-based streaming — avoids SSE buffering issues in Next.js dev server.
    // Events are polled from the DB every second and forwarded as NDJSON.
    let cancelled = false;
    return new ReadableStream({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        let lastSequence = 0;
        let consecutiveEmptyPolls = 0;
        const maxEmptyPolls =
          STREAM_INACTIVITY_TIMEOUT_MS / STREAM_POLL_INTERVAL_MS;

        try {
          while (!cancelled && consecutiveEmptyPolls < maxEmptyPolls) {
            await new Promise((resolve) =>
              setTimeout(resolve, STREAM_POLL_INTERVAL_MS)
            );

            const events = await self.pollCommandEvents(targetId, commandId);
            if (cancelled) {
              break;
            }
            let foundNew = false;

            for (const event of events) {
              if (
                typeof event.sequence === "number" &&
                event.sequence > lastSequence
              ) {
                lastSequence = event.sequence;
                foundNew = true;
                const output = mapCommandEventToNdjsonLine(event);
                controller.enqueue(
                  encoder.encode(`${JSON.stringify(output)}\n`)
                );

                if (isEventTerminal(event)) {
                  controller.close();
                  return;
                }
              }
            }

            if (foundNew) {
              consecutiveEmptyPolls = 0;
            } else {
              consecutiveEmptyPolls++;
            }
          }

          // Inactivity timeout reached
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "error", error: "Stream timed out due to inactivity" })}\n`
            )
          );
          controller.close();
        } catch (error) {
          log.error("Relay command event polling failed", {
            targetId,
            commandId,
            error,
          });
          if (!cancelled) {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({
                  type: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Relay command event polling failed",
                })}\n`
              )
            );
            controller.close();
          }
        }
      },
    });
  }
}
