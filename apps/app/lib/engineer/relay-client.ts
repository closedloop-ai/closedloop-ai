import type { ApiResult, JsonValue } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  DesktopCommandEvent,
} from "@repo/api/src/types/compute-target";

const RESULT_STREAM_TIMEOUT_MS = 120_000;

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
  if (typeof value.status !== "number" || !("body" in value)) {
    return null;
  }
  return {
    status: value.status,
    body: value.body,
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
    body: request.body as unknown as JsonValue,
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
  private readonly authToken: string;

  constructor(apiOrigin: string, authToken: string) {
    this.apiOrigin = apiOrigin;
    this.authToken = authToken;
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
    const timeout = setTimeout(
      () => abortController.abort(),
      RESULT_STREAM_TIMEOUT_MS
    );

    try {
      const response = await this.openCommandEventsStream(
        targetId,
        commandId,
        abortController.signal
      );

      for await (const payload of readSseData(response)) {
        const event = JSON.parse(payload) as DesktopCommandEvent;
        if (isTerminalErrorEvent(event)) {
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
    }

    throw new Error("Relay result stream ended without a terminal event");
  }

  async streamOperation(
    targetId: string,
    request: RelayHttpRequestPayload
  ): Promise<ReadableStream<Uint8Array>> {
    const operationId = crypto.randomUUID();
    const commandInput = toDesktopCommandInput(operationId, request, true);
    const { commandId } = await this.createCommand(targetId, commandInput);

    const upstreamController = new AbortController();
    const response = await this.openCommandEventsStream(
      targetId,
      commandId,
      upstreamController.signal
    );

    const encoder = new TextEncoder();

    return new ReadableStream({
      async start(controller) {
        try {
          for await (const payload of readSseData(response)) {
            const event = JSON.parse(payload) as DesktopCommandEvent;
            const output = mapCommandEventToNdjsonLine(event);
            controller.enqueue(encoder.encode(`${JSON.stringify(output)}\n`));

            if (isEventTerminal(event)) {
              controller.close();
              return;
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        upstreamController.abort();
      },
    });
  }
}
