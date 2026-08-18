import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { buildRequestCompletedContractAttributes } from "@repo/observability/telemetry/request-completed";
// `tracing/hooks` deliberately, NOT `tracing/provider`: this module is imported
// by ~40 routes, and importing the provider would make the OpenTelemetry Node
// SDK statically reachable from all of them — breaking the first route that
// ever opts into the edge runtime.
import { flushSpans, isTracingActive } from "@repo/observability/tracing/hooks";
import { waitUntil } from "@vercel/functions";
import { after, NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header.
 * Returns `null` when the header is absent or not a bearer scheme. Shared by the
 * auth middlewares (API-key, desktop-session) so token extraction stays
 * identical across them.
 */
export function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

/**
 * Parse an `afterSequence` reconnect cursor from a raw request value (query
 * param or `Last-Event-ID` header). Returns the cursor when it is a
 * non-negative integer, otherwise `undefined`. Shared by the SSE routes that
 * resume an event stream from the last-seen sequence.
 */
export function parseSequenceCursor(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Standard route params type for [id] routes.
 */
export type IdRouteParams<T extends string = "id"> = {
  params: Promise<{ [K in T]: string }>;
};

/**
 * Result of parsing a request body.
 *
 * `rawBody` is the parsed JSON BEFORE validation, carried out so a caller that
 * needs to diff the raw payload against the validated one does not read and
 * parse the request a second time. `undefined` when the body never became an
 * object — over the cap, or unparseable.
 */
export type ParseBodyResult<T> =
  | { body: T; rawBody: unknown; errorResponse: null }
  | {
      body: null;
      rawBody: unknown;
      errorResponse: NextResponse<ApiResult<never>>;
    };

export type ParseBodyOptions = {
  /** Maximum allowed UTF-8 request body size in bytes. */
  maxBytes?: number;
};

export type CappedRequestTextResult =
  | { ok: true; value: string }
  | { ok: false };

/**
 * Result of parsing a request query params.
 */
export type ParseParamsResult<T> =
  | { params: T; errorResponse: null }
  | { params: null; errorResponse: NextResponse<ApiResult<never>> };

/**
 * Parse and validate request body against a zod schema.
 * Returns an object with either body (on success) or errorResponse (on failure).
 */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  validator: T,
  options: ParseBodyOptions = {}
): Promise<ParseBodyResult<z.infer<T>>> {
  try {
    const bodyTextResult =
      options.maxBytes === undefined
        ? { ok: true as const, value: await request.text() }
        : await readCappedRequestText(request, options.maxBytes);
    if (!bodyTextResult.ok) {
      return {
        body: null,
        rawBody: undefined,
        errorResponse: NextResponse.json(failure("Request body too large"), {
          status: 413,
        }),
      };
    }

    const rawBody = JSON.parse(bodyTextResult.value) as unknown;
    const parseResult = validator.safeParse(rawBody);

    if (!parseResult.success) {
      return {
        body: null,
        rawBody,
        errorResponse: badRequestResponse(
          formatZodErrors(parseResult.error.issues)
        ),
      };
    }

    return { body: parseResult.data, rawBody, errorResponse: null };
  } catch (error) {
    log.error("Failed to parse request body:", { error });
    scheduleLogFlush();
    return {
      body: null,
      rawBody: undefined,
      errorResponse: NextResponse.json(failure("Invalid JSON body"), {
        status: 400,
      }),
    };
  }
}

/**
 * Read a request body as text while enforcing a streaming byte limit.
 * Use this before parsing large JSON bodies that may carry base64 payloads.
 */
export async function readCappedRequestText(
  request: Request,
  maxBytes: number
): Promise<CappedRequestTextResult> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, value: "" };
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return {
        ok: true,
        value: `${chunks.join("")}${decoder.decode()}`,
      };
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
}

/**
 * Parse and validate query parameters against a zod schema.
 * Returns an object with either params (on success) or errorResponse (on failure).
 *
 * @example
 * const { params, errorResponse } = parseQueryParams(request, myValidator);
 * if (errorResponse) return errorResponse;
 * // params is now typed as z.infer<typeof myValidator>
 *
 * @param request - NextRequest with searchParams
 * @param validator - Zod schema to validate against
 * @returns ParseParamsResult with typed params or error response
 */
export function parseQueryParams<T extends z.ZodType>(
  request: { nextUrl: { searchParams: URLSearchParams } },
  validator: T
): ParseParamsResult<z.infer<T>> {
  const queryParams: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const values = request.nextUrl.searchParams.getAll(key);
    queryParams[key] = values.length === 1 ? values[0] : values;
  }
  const parseResult = validator.safeParse(queryParams);

  if (!parseResult.success) {
    return {
      params: null,
      errorResponse: badRequestResponse(
        formatZodErrors(parseResult.error.issues)
      ),
    };
  }

  return { params: parseResult.data, errorResponse: null };
}

/**
 * Parse repository child-route limit values with the shared route cap.
 * Returns `NaN` when the caller should reject an invalid user-provided limit.
 */
export function parseRepositoryRouteLimit(
  value: string | null,
  defaultLimit: number
): number {
  const parsed = value ? Number.parseInt(value, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return Number.NaN;
  }
  return Math.min(Math.max(1, parsed), 100);
}

/**
 * Create a standardized error response with sanitized logging.
 * Calls scheduleLogFlush() internally — callers must not add a redundant flush.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  log.error(message, { error });
  scheduleLogFlush();
  return NextResponse.json(failure(message, metadata), { status });
}

/**
 * Create a bad request response.
 */
export function badRequestResponse(
  message: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message, metadata), { status: 400 });
}

/**
 * Create a success response.
 */
export function successResponse<T>(data: T): NextResponse<ApiResult<T>> {
  return NextResponse.json(success(data));
}

/**
 * Create a not found response.
 */
export function notFoundResponse(
  entity: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(`${entity} not found`, metadata), {
    status: 404,
  });
}

/**
 * Create an unauthorized response.
 */
export function unauthorizedResponse(
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Unauthorized", metadata), { status: 401 });
}

/**
 * Create a forbidden response.
 */
export function forbiddenResponse(
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Forbidden", metadata), { status: 403 });
}

/**
 * Create a standard delete success response.
 */
export function deleteResponse(): NextResponse<ApiResult<{ deleted: true }>> {
  return NextResponse.json(success({ deleted: true }));
}

/**
 * Create a payload-too-large response (HTTP 413).
 * Use when a request or asset exceeds an enforced size/entry budget.
 */
export function payloadTooLargeResponse(
  message: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message, metadata), { status: 413 });
}

/**
 * Create a conflict response (HTTP 409).
 * Use when a request conflicts with the current state of a resource.
 */
export function conflictResponse(
  message: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message, metadata), { status: 409 });
}

/**
 * Create a gone response (HTTP 410).
 * Use when a resource existed but is no longer available and will not return.
 */
export function goneResponse(
  message: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message, metadata), { status: 410 });
}

/**
 * Create a service-unavailable response (HTTP 503).
 * Use when a dependency the request needs could not be reached, so the server
 * could not decide the request at all. Distinct from a 4xx, which IS a decision.
 * The condition is presumed transient and the request safe to repeat; whether a
 * given client actually retries is that client's policy, not this helper's.
 */
export function serviceUnavailableResponse(
  message: string,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message, metadata), { status: 503 });
}

/**
 * Format Zod validation issues into a human-readable error string.
 * Includes field paths so callers know which fields failed.
 */
export function formatZodErrors(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
}

export function scheduleLogFlush(): void {
  waitUntil(log.flush().catch(() => {}));
  scheduleSpanFlush();
}

export function scheduleLogFlushAfter(promise: Promise<unknown>): void {
  waitUntil(promise.finally(() => log.flush().catch(() => {})));
  // The supplied promise is chained into the span flush too. Callers use this
  // form precisely because work is still running past the response (launchLoop,
  // the heartbeat drains) — and that work produces spans. Flushing without
  // waiting for it would export the buffer as it stands and let the deferred
  // work's spans freeze with the function.
  scheduleSpanFlush(promise);
}

/**
 * ISS-4659: flush buffered spans before the serverless function freezes. The
 * tracer batches spans, so without this the request's trace is dropped on
 * Vercel exactly as an unflushed log line would be.
 *
 * Two details are load-bearing:
 *
 * 1. **`after()`, not `waitUntil()`.** Next closes the route's own span *after*
 *    the handler promise resolves, but `logRequestCompleted` runs inside the
 *    auth wrapper's `finally` — i.e. while that span is still open. A
 *    `waitUntil(flushSpans())` would start the export immediately and miss the
 *    root span. `after()` runs past the response, once the span has ended.
 * 2. **Attached to every log-flush site, not just the request-completed one.**
 *    Routes that bypass the auth wrappers — `/health`, the GitHub webhook, the
 *    cron drains — never call `logRequestCompleted`, so hanging the span flush
 *    there alone would silently drop their traces. A `forceFlush()` on an
 *    already-drained buffer is a cheap no-op, so covering every terminal flush
 *    site costs far less than the spans it saves.
 * 3. **`pending` is awaited before flushing.** `scheduleLogFlushAfter` passes
 *    the caller's still-running work; that work emits spans of its own, so
 *    flushing ahead of it would export the buffer as it stands and lose them.
 *    A rejection is swallowed — the flush must happen either way.
 */
function scheduleSpanFlush(pending?: Promise<unknown>): void {
  // Schedule nothing when no tracer is installed — every local run, every CI
  // worker, and any deploy with the kill switch set. `flushSpans()` would be a
  // no-op anyway, but scheduling it still consumes a `waitUntil` slot, and
  // route tests legitimately assert on how much deferred work a request
  // schedules (with-api-key-auth and branch-artifact-flows both pin the count).
  if (!isTracingActive()) {
    return;
  }
  const flush = pending
    ? () => pending.catch(() => undefined).then(() => flushSpans())
    : () => flushSpans();
  try {
    after(flush);
  } catch {
    // `after()` throws outside a request scope (unit tests, module init, the
    // containerized custom-server path). There is no route span to wait on in
    // that case, so flushing immediately is both safe and correct.
    waitUntil(flush());
  }
}

/**
 * Emit a single `request_completed` log line for the given request/response
 * pair. Field names are the snake_case attributes the Datadog log-based
 * generators (api.requests.count, api.errors.count, api.requests.latency)
 * group on. `scheduleLogFlush()` is invoked so the log — and, via
 * `scheduleSpanFlush()`, the request's buffered spans — reach Datadog before
 * the serverless function freezes.
 *
 * ISS-5039: "a single log line" is now literal. The OTel-named contract
 * attributes ride along on this same line instead of a second
 * `request_completed.contract` line, because every deployed log call is
 * already billed twice — once through the Vercel Log Drain (`source:vercel`)
 * and once through the agentless intake (`source:nodejs`) — so a second line
 * cost two more billed events per request for values this line already
 * carried, and nothing queried it by name.
 *
 * The snake_case fields are spread AFTER the contract attributes so the keys
 * the metrics and monitors group on always win a collision. `duration_ms` is
 * the only overlap and both sides carry the same value.
 *
 * The `dd.trace_id`/`dd.span_id` correlation fields are NOT set here: the
 * logger stamps them onto every entry from the active span (ISS-4659).
 *
 * Call this from a `finally` block in the auth wrappers so it fires whether
 * the handler returned normally or threw.
 */
export function logRequestCompleted(
  request: Request,
  startMs: number,
  statusCode: number
): void {
  const durationMs = Math.round(globalThis.performance.now() - startMs);
  log.info("request_completed", {
    ...buildRequestCompletedContractAttributes({
      requestUrl: request.url,
      method: request.method,
      statusCode,
      durationMs,
    }),
    path: new URL(request.url).pathname,
    method: request.method,
    status_code: statusCode,
    duration_ms: durationMs,
  });
  scheduleLogFlush();
}

/**
 * Emit the correlated ingest-failure log line shared by the loop event-ingest
 * routes (`/loops/[id]/events` and `/loops/[id]/manual-events`). Both stitch
 * the failure to its loop/org in Datadog with the same field shape; centralizing
 * it here keeps that shape defined once. `eventName` is the route-specific
 * metric name (e.g. `loop.event_ingest_failed`, `loop.manual_event_ingest_failed`).
 */
export function logLoopIngestFailure(
  eventName: string,
  fields: {
    error: unknown;
    loopId: string | undefined;
    organizationId: string | undefined;
  }
): void {
  log.error(eventName, {
    error: fields.error,
    loopId: fields.loopId,
    organizationId: fields.organizationId,
  });
}

type ErrorResponseMetadata = {
  code?: string;
  details?: JsonObject;
  timestamp?: string;
};
