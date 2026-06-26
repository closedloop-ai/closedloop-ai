import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import { BranchViewLocalErrorCode } from "@repo/api/src/types/branch-view-local";
import type { ApiResult } from "@repo/api/src/types/common";
import type {
  BrowserSignedCommandId,
  CommandSignatureFields,
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
  DesktopCommandEvent,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import type {
  RelayHttpRequestPayload,
  RelayResponseEnvelope,
} from "@repo/shared-platform/relay-request-model";
import {
  isRecord,
  normalizeMethod,
  parseRelayResponseEnvelope,
  splitPathAndQuery,
  unwrapRelayBody,
} from "@repo/shared-platform/relay-request-model";

const RESULT_STREAM_TIMEOUT_MS = 120_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 270_000; // Must be < maxDuration (300s) to allow error flush
const STREAM_POLL_INTERVAL_MS = 1000;

export type RelayCommandSigningInput = CommandSignatureFields & {
  commandId: BrowserSignedCommandId;
};

export type RelayCommandOptions = {
  /**
   * Forces event reads through the public author-scoped route. Branch View
   * local commands can persist local file content in event payloads, so they
   * must not use the internal service-to-service fallback.
   */
  localContent?: boolean;
};

type ApiFailurePayload = {
  success: false;
  error: string;
  code?: string;
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

function getSseDataLines(rawEvent: string): string[] {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines;
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

      const dataLines = getSseDataLines(rawEvent);

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
    const dataLines = getSseDataLines(remaining);
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

function makeCommandEventsPollUrl(
  apiOrigin: string,
  targetId: string,
  commandId: string,
  afterSequence?: number
): string {
  let url = `${apiOrigin}/compute-targets/${encodeURIComponent(targetId)}/commands/${encodeURIComponent(commandId)}/events`;
  if (afterSequence != null) {
    url += `?afterSequence=${afterSequence}`;
  }
  return url;
}

function makeInternalCommandEventsPollUrl(
  apiOrigin: string,
  targetId: string,
  commandId: string,
  afterSequence?: number
): string {
  let url = `${apiOrigin}/internal/compute-targets/${encodeURIComponent(targetId)}/commands/${encodeURIComponent(commandId)}/events`;
  if (afterSequence != null) {
    url += `?afterSequence=${afterSequence}`;
  }
  return url;
}

function isApiFailurePayload(value: unknown): value is ApiFailurePayload {
  return (
    isRecord(value) &&
    value.success === false &&
    typeof value.error === "string"
  );
}

function toDesktopCommandInput(
  operationId: string,
  request: RelayHttpRequestPayload,
  streaming: boolean,
  signing?: RelayCommandSigningInput
): CreateDesktopCommandInput {
  const { path, query } = splitPathAndQuery(request.path);
  if (!isDesktopApiPath(path)) {
    throw new Error(`Relay path must target /api/gateway/*, got: ${path}`);
  }

  return {
    ...(signing ? { commandId: signing.commandId } : {}),
    operationId,
    method: normalizeMethod(request.method),
    path,
    headers: request.headers,
    query,
    body: unwrapRelayBody(request.body),
    streaming,
    ...(signing
      ? {
          signature: signing.signature,
          signaturePayload: signing.signaturePayload,
          publicKeyFingerprint: signing.publicKeyFingerprint,
        }
      : {}),
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

export function isStreamingGatewayRequest(
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
  if (!isDesktopApiPath(pathname)) {
    return false;
  }
  return [
    /^\/api\/gateway\/symphony\/chat\/[^/]+$/,
    /^\/api\/gateway\/symphony\/comment-chat\/[^/]+$/,
    /^\/api\/gateway\/codex\/chat\/[^/]+$/,
    /^\/api\/gateway\/codex\/argue\/[^/]+$/,
    /^\/api\/gateway\/codex\/review\/[^/]+$/,
    /^\/api\/gateway\/codex\/finding-chat\/[^/]+$/,
    /^\/api\/gateway\/ticket-chat$/,
    /^\/api\/gateway\/terminal-chat$/,
    /^\/api\/gateway\/run-viewer-chat$/,
    /^\/api\/gateway\/chat$/,
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
    request: RelayHttpRequestPayload,
    signing?: RelayCommandSigningInput,
    options: RelayCommandOptions = {}
  ): Promise<{ envelope: RelayResponseEnvelope | null; value: unknown }> {
    const operationId = crypto.randomUUID();
    const commandInput = toDesktopCommandInput(
      operationId,
      request,
      false,
      signing
    );
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
          // Terminal event without a result (e.g. bare "done") — the result
          // event was likely lost during SSE delivery. Fall back to polling
          // the DB for the full event log before giving up.
          //
          // Invariant: recoverMissedResult calls pollCommandEvents which does
          // a direct DB read (GET .../events), NOT the SSE relay path. The
          // desktop emits result→done sequentially via ingestCommandEvent(),
          // so the result row is committed before done becomes observable.
          // The retry loop is defensive margin for transient read failures,
          // not a budget matching the gateway's 2s SSE cross-process poll.
          const recovered = await this.recoverMissedResult(
            targetId,
            commandId,
            options
          );
          if (recovered) {
            return recovered;
          }
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

    // SSE stream ended without any terminal event — poll as last resort
    const recovered = await this.recoverMissedResult(
      targetId,
      commandId,
      options
    );
    if (recovered) {
      return recovered;
    }
    throw new Error("Relay result stream ended without a terminal event");
  }

  /**
   * Poll the DB for a missed `result` event when the SSE stream delivered a
   * terminal event (done) without a preceding result. Returns the result
   * envelope if found, or null to let the caller fall through to its default.
   */
  private async recoverMissedResult(
    targetId: string,
    commandId: string,
    options: RelayCommandOptions = {}
  ): Promise<{
    envelope: RelayResponseEnvelope | null;
    value: unknown;
  } | null> {
    // pollCommandEvents does a direct DB read (GET .../events), NOT the SSE
    // relay path. By the time we see "done", the result row is almost certainly
    // committed — both events go through ingestCommandEvent() sequentially.
    // The retry loop covers edge cases like cold connection pools, DB failover,
    // or Neon autoscale wake-up latency. 4 × 750ms ≈ 2.25s total budget.
    const maxAttempts = 4;
    const delayMs = 750;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const events = await this.pollCommandEvents(
          targetId,
          commandId,
          undefined,
          options
        );
        const resultEvent = events.find((e) => e.eventType === "result");
        if (resultEvent) {
          const line = mapCommandEventToNdjsonLine(resultEvent);
          log.info("Recovered missed result event via poll fallback", {
            computeTargetId: targetId,
            commandId,
            attempt,
          });
          return {
            envelope: parseRelayResponseEnvelope(line),
            value: line,
          };
        }
      } catch (err) {
        log.warn("Poll fallback for missed result failed", {
          computeTargetId: targetId,
          commandId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private async pollCommandEvents(
    targetId: string,
    commandId: string,
    afterSequence?: number,
    options: RelayCommandOptions = {}
  ): Promise<DesktopCommandEvent[]> {
    const useInternalRoute =
      options.localContent !== true &&
      typeof this.internalApiSecret === "string" &&
      this.internalApiSecret.length > 0;
    const url = useInternalRoute
      ? makeInternalCommandEventsPollUrl(
          this.apiOrigin,
          targetId,
          commandId,
          afterSequence
        )
      : makeCommandEventsPollUrl(
          this.apiOrigin,
          targetId,
          commandId,
          afterSequence
        );
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

  /**
   * Shared poll loop used by both `streamOperation` and `resumeStream`.
   * Emits keepalive + relay_meta at start, then polls for events as NDJSON.
   */
  private _createPollingStream(
    targetId: string,
    commandId: string,
    afterSequence: number,
    options: RelayCommandOptions = {}
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;
    let cancelled = false;

    return new ReadableStream({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        let lastSequence = afterSequence;
        let consecutiveEmptyPolls = 0;
        const maxEmptyPolls =
          STREAM_INACTIVITY_TIMEOUT_MS / STREAM_POLL_INTERVAL_MS;

        // Emit keepalive so the HTTP response is flushed immediately.
        controller.enqueue(encoder.encode('{"type":"keepalive"}\n'));
        // Emit relay_meta with commandId so the client can reconnect.
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "relay_meta", commandId })}\n`
          )
        );

        try {
          while (!cancelled && consecutiveEmptyPolls < maxEmptyPolls) {
            await new Promise((resolve) =>
              setTimeout(resolve, STREAM_POLL_INTERVAL_MS)
            );

            const events = await self.pollCommandEvents(
              targetId,
              commandId,
              lastSequence,
              options
            );
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
                output._seq = event.sequence;
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
              `${JSON.stringify({ type: "error", error: "Stream timed out due to inactivity", relay: true })}\n`
            )
          );
          controller.close();
        } catch (error) {
          log.error("Relay command event polling failed", {
            targetId,
            computeTargetId: targetId,
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
                  relay: true,
                })}\n`
              )
            );
            controller.close();
          }
        }
      },
    });
  }

  async streamOperation(
    targetId: string,
    request: RelayHttpRequestPayload,
    signing?: RelayCommandSigningInput,
    options: RelayCommandOptions = {}
  ): Promise<{ stream: ReadableStream<Uint8Array>; commandId: string }> {
    const operationId = crypto.randomUUID();
    const commandInput = toDesktopCommandInput(
      operationId,
      request,
      true,
      signing
    );
    const { commandId } = await this.createCommand(targetId, commandInput);
    const stream = this._createPollingStream(targetId, commandId, 0, options);
    return { stream, commandId };
  }

  async resolveResumeOptions(
    targetId: string,
    commandId: string
  ): Promise<RelayCommandOptions> {
    if (!(this.internalApiSecret && this.internalApiSecret.length > 0)) {
      return {};
    }

    const internalResponse = await fetch(
      makeInternalCommandEventsPollUrl(this.apiOrigin, targetId, commandId, 0),
      {
        method: "GET",
        cache: "no-store",
        headers: { "x-internal-secret": this.internalApiSecret },
      }
    );
    if (internalResponse.ok) {
      return {};
    }

    const internalPayload = (await internalResponse
      .json()
      .catch(() => null)) as unknown;
    const requiresPublicRead =
      internalResponse.status === 403 &&
      isApiFailurePayload(internalPayload) &&
      internalPayload.code === BranchViewLocalErrorCode.PublicEventReadRequired;
    if (!requiresPublicRead) {
      throw new RelayRequestError(
        isApiFailurePayload(internalPayload)
          ? internalPayload.error
          : "Relay resume authorization failed",
        internalResponse.status,
        internalPayload
      );
    }

    const publicResponse = await fetch(
      makeCommandEventsPollUrl(this.apiOrigin, targetId, commandId, 0),
      {
        method: "GET",
        cache: "no-store",
        headers: { Authorization: `Bearer ${this.authToken}` },
      }
    );
    if (!publicResponse.ok) {
      throw await parsePollError(publicResponse);
    }
    return { localContent: true };
  }

  resumeStream(
    targetId: string,
    commandId: string,
    afterSequence: number,
    options: RelayCommandOptions = {}
  ): { stream: ReadableStream<Uint8Array>; commandId: string } {
    const stream = this._createPollingStream(
      targetId,
      commandId,
      afterSequence,
      options
    );
    return { stream, commandId };
  }
}
