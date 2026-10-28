import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import type { OperationReceipt } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import {
  buildRequestCompletedContractAttributes,
  type RequestCompletedSpanAttribution,
} from "@repo/observability/telemetry/request-completed";
// `tracing/hooks` deliberately, NOT `tracing/provider`: this module is imported
// by ~40 routes, and importing the provider would make the OpenTelemetry Node
// SDK statically reachable from all of them — breaking the first route that
// ever opts into the edge runtime.
import { flushSpans, isTracingActive } from "@repo/observability/tracing/hooks";
import { waitUntil } from "@vercel/functions";
import { after, NextResponse } from "next/server";
import type { z } from "zod";
import { isStorableInt4Count } from "./int4-column-bounds";
import type { RequestErrorCode } from "./observability/request-error-code";
import {
  type RouteParams,
  toRouteTemplatePath,
} from "./observability/request-route-path";
import {
  getRequestListQueryLogFields,
  getRequestSpanAttribution,
  recordRequestErrorCause,
} from "./observability/request-span-attribution";

/**
 * Lowest HTTP status that means "the server failed", not "the caller did".
 * The boundary for both the `status:error` log level and every span attribute
 * that describes a server error (ISS-7217).
 */
const SERVER_ERROR_STATUS_MIN = 500;

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
 * non-negative integer that fits int4, otherwise `undefined`. Shared by the SSE
 * routes that resume an event stream from the last-seen sequence. The ceiling
 * is the column's: the cursor is bound as `::int`, and a larger value raised
 * 22003 as a 500 (ISS-11195).
 */
export function parseSequenceCursor(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return isStorableInt4Count(value) ? value : undefined;
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
  | { body: T; rawBody: unknown; errorResponse: null; issues?: undefined }
  | {
      body: null;
      rawBody: unknown;
      errorResponse: NextResponse<ApiResult<never>>;
      /**
       * The raw Zod issues behind `errorResponse`, present ONLY when validation
       * itself failed. A route that must react to one specific field's failure
       * — rather than just forwarding the formatted 400 — matches on
       * `issue.path`/`issue.code` instead of re-parsing the body against a
       * second schema that could drift from the first.
       *
       * Absent for the non-validation failures (malformed JSON, over-cap),
       * which never produced issues.
       */
      issues?: z.core.$ZodIssue[];
    };

export type ParseBodyOptions = {
  /**
   * Maximum allowed UTF-8 request body size in bytes. Defaults to
   * `DEFAULT_REQUEST_MAX_BYTES`, so a route opts into a DIFFERENT bound, never
   * into no bound at all (ISS-7565).
   */
  maxBytes?: number;
};

export type CappedRequestTextResult =
  | { ok: true; value: string; bytesRead: number }
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
  const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_MAX_BYTES;
  let bodyTextResult: CappedRequestTextResult;
  try {
    bodyTextResult = await readCappedRequestText(request, maxBytes);
  } catch (error) {
    return requestBodyReadFailureResult(error);
  }

  if (!bodyTextResult.ok) {
    logRequestBodyOverCap(request, maxBytes);
    return {
      body: null,
      rawBody: undefined,
      errorResponse: payloadTooLargeResponse("Request body too large"),
    };
  }

  const truncationError = requestBodyTruncationError(
    request,
    bodyTextResult.bytesRead
  );
  if (truncationError !== null) {
    return requestBodyReadFailureResult(truncationError);
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(bodyTextResult.value) as unknown;
  } catch (error) {
    return requestBodyParseFailureResult(error);
  }

  try {
    const parseResult = validator.safeParse(rawBody);

    if (!parseResult.success) {
      return {
        body: null,
        rawBody,
        errorResponse: badRequestResponse(
          formatZodErrors(parseResult.error.issues)
        ),
        issues: parseResult.error.issues,
      };
    }

    return { body: parseResult.data, rawBody, errorResponse: null };
  } catch (error) {
    return requestBodyParseFailureResult(error);
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
    return { ok: true, value: "", bytesRead: 0 };
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
        bytesRead,
      };
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      try {
        await reader.cancel();
      } catch (error) {
        log.error("Failed to cancel over-cap request body stream", { error });
        // Flush here rather than relying on the caller: a caller that answers
        // its own 413 inline, without `logRequestBodyOverCap`, leaves nothing
        // downstream to flush this line.
        scheduleLogFlush();
      }
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
 * @param options.errorMetadata - Reads a structured `code`/`details` off the
 *   failing issues (ISS-9477's list query refusals). Returning `undefined`
 *   keeps the plain 400, which is also the behavior when it is omitted.
 * @returns ParseParamsResult with typed params or error response
 */
export function parseQueryParams<T extends z.ZodType>(
  request: { nextUrl: { searchParams: URLSearchParams } },
  validator: T,
  options?: {
    errorMetadata?: (
      issues: readonly z.core.$ZodIssue[]
    ) => ErrorResponseMetadata | undefined;
  }
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
        formatZodErrors(parseResult.error.issues),
        options?.errorMetadata?.(parseResult.error.issues)
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
 *
 * ISS-7217: a server error also records its cause onto the request's span
 * attribution. This is the single highest-leverage instrumentation point for
 * that — it is the shape ~200 route catch blocks already use, and it is handed
 * the real error, so no call site changes. Only a 5xx records: a 4xx is a
 * client-side outcome the route deliberately returned, and marking it as a
 * server-error cause would inflate the very population the RCA is trying to
 * read.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  log.error(message, { error });
  if (status >= SERVER_ERROR_STATUS_MIN) {
    recordRequestErrorCause(error, SpanErrorSource.RouteHandler);
  }
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
 *
 * `init` exists for responses that carry metadata a client reads OUTSIDE the
 * body — `GET /documents` states its pagination continuation in headers so the
 * bare-array body stays exactly what every shipped consumer already parses
 * (ISS-6941). It is a plain `ResponseInit`, so a caller can also set a status;
 * nothing here defaults one, and omitting `init` is byte-identical to before.
 */
export function successResponse<T>(
  data: T,
  init?: ResponseInit
): NextResponse<ApiResult<T>> {
  return NextResponse.json(success(data), init);
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
export function deleteResponse(
  operationReceipt?: OperationReceipt
): NextResponse<
  ApiResult<{ deleted: true; operationReceipt?: OperationReceipt }>
> {
  // ISS-12552: an API-key delete carries its receipt; omitted otherwise.
  return NextResponse.json(
    success({
      deleted: true,
      ...(operationReceipt ? { operationReceipt } : {}),
    })
  );
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
  // form precisely because work is still running past the response — and that
  // work produces spans. Flushing without
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
 *    Routes that bypass both the auth wrappers and `withRequestCompleted` —
 *    the cron drains — never call `logRequestCompleted`, so hanging
 *    the span flush there alone would silently drop their traces. A
 *    `forceFlush()` on an already-drained buffer is a cheap no-op, so covering
 *    every terminal flush site costs far less than the spans it saves.
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
 * Call this from a `finally` block — the auth wrappers', or
 * `withRequestCompleted`'s for a route that authenticates itself (ISS-9053) —
 * so it fires whether the handler returned normally or threw.
 *
 * ISS-7217/ISS-7221/ISS-7224: the line also carries whatever the request
 * managed to attribute about itself — the tenant, the artifact, and the cause
 * of a 5xx — and a 5xx is emitted at `error` level rather than `info`, so
 * `status:error` searches and error-rate monitors see it. That attribution
 * adds fields and changes none of the snake_case ones the log-based metrics
 * group on (`path` is templated separately, ISS-12274 below).
 *
 * ISS-12168: a 4xx also carries its contract `error_code`, snake_case like the
 * fields beside it, so the per-route denial monitors can group by why a route
 * refused rather than only that it did. `readResponseErrorCode` decides it;
 * absent, the key is omitted, never `null`.
 *
 * ISS-12274: `path` is the matched route template (`/branches/:id`), built
 * from the route's resolved `routeParams`, so the `@path` tag of
 * `api.requests.count` / `api.errors.count` / `api.requests.latency.app` is
 * one series per route rather than per record id.
 */
export function logRequestCompleted(
  request: Request,
  startMs: number,
  statusCode: number,
  errorCode: RequestErrorCode | undefined,
  routeParams: RouteParams | undefined
): void {
  const durationMs = Math.round(globalThis.performance.now() - startMs);
  const fields = {
    ...buildRequestCompletedContractAttributes({
      requestUrl: request.url,
      method: request.method,
      statusCode,
      durationMs,
      attribution: resolveRequestCompletedAttribution(statusCode),
    }),
    ...getRequestListQueryLogFields(),
    path: toRouteTemplatePath(new URL(request.url).pathname, routeParams),
    method: request.method,
    status_code: statusCode,
    duration_ms: durationMs,
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
  };
  if (statusCode >= SERVER_ERROR_STATUS_MIN) {
    log.error(REQUEST_COMPLETED_EVENT, fields);
  } else {
    log.info(REQUEST_COMPLETED_EVENT, fields);
  }
  scheduleLogFlush();
}

/**
 * Narrow the request's accumulated attribution to what this response can
 * honestly claim.
 *
 * Two rules, both about not letting a value describe a population it does not
 * belong to:
 *
 *   • Error attribution appears ONLY on a 5xx. A route that caught something,
 *     recovered, and returned 200 recorded a cause that never became a failure;
 *     stamping it would put an `app.error.source` on a successful span.
 *   • A 5xx with no recorded cause is stamped `unattributed` rather than left
 *     blank. That keeps an uninstrumented failure countable and visibly
 *     distinct from an attributed one — otherwise the attributed counts would
 *     silently claim to describe every 5xx.
 */
function resolveRequestCompletedAttribution(
  statusCode: number
): RequestCompletedSpanAttribution | undefined {
  // A copy, so dropping the error half here cannot affect anything else that
  // reads the request's store.
  const attribution = getRequestSpanAttribution();
  if (statusCode >= SERVER_ERROR_STATUS_MIN) {
    return {
      ...attribution,
      errorSource: attribution?.errorSource ?? SpanErrorSource.Unattributed,
    };
  }
  if (!attribution) {
    return undefined;
  }
  Reflect.deleteProperty(attribution, "errorSource");
  Reflect.deleteProperty(attribution, "errorType");
  return attribution;
}

type ErrorResponseMetadata = {
  code?: string;
  details?: JsonObject;
  timestamp?: string;
};

/**
 * Create an accepted (202) response for work the route handed to `waitUntil`
 * instead of awaiting (ISS-7408).
 *
 * 202 rather than 200 is the load-bearing part: it tells the caller the payload
 * describes an ACCEPTED run, not a finished one, so a client cannot mistake the
 * response for a completed result and render it as settled state.
 */
export function acceptedResponse<T>(data: T): NextResponse<ApiResult<T>> {
  return NextResponse.json(success(data), { status: 202 });
}

/**
 * Default request-body byte cap for `parseBody` (ISS-7565).
 *
 * A backstop, not a business rule: it exists so a route is bounded WITHOUT a
 * per-call-site edit, and so the next route added is bounded by construction.
 * 4 MiB clears every payload this API accepts today — the widest explicit cap
 * in the repo is 256 KiB — and sits under the platform's serverless request
 * ceiling, so the bound lives in code we test rather than in a host default.
 * Surfaces that know their real payload size pass a tighter `maxBytes`.
 */
export const DEFAULT_REQUEST_MAX_BYTES = 4_194_304;

/**
 * Datadog event name for a request refused by the body cap, emitted by every
 * bounded reader (`parseBody` and the desktop `readBounded*` helpers). A cap
 * that starts firing has to be visible: without this the refusal is silent and
 * indistinguishable from a client that never called.
 */
export const REQUEST_BODY_OVER_CAP_EVENT = "api.request_body_over_cap";

export function logRequestBodyOverCap(
  request: Request,
  maxBytes: number
): void {
  log.warn(REQUEST_BODY_OVER_CAP_EVENT, {
    maxBytes,
    method: request.method,
    path: safeRequestPath(request),
  });
  scheduleLogFlush();
}

function safeRequestPath(request: Request): string | undefined {
  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}

const CONTENT_LENGTH_BYTES_PATTERN = /^\d+$/;

/**
 * A stream that ended before its declared `Content-Length` delivered an
 * incomplete body, whether or not the transport surfaced an abort: some expose
 * an early EOF as a clean close, and treating only the aborted case as
 * truncation leaves the rest to be misreported as malformed client JSON.
 *
 * `Content-Length` counts wire bytes, and every bounded reader in this app
 * consumes `request.body` UNDECODED — `readBoundedMaybeGzipJsonBody` gunzips
 * the bytes itself, which it could not do if the platform had already expanded
 * them. So the two counts describe the same bytes under a content coding too,
 * and a coded body is compared like any other.
 */
function requestBodyWasTruncated(request: Request, bytesRead: number): boolean {
  const contentLengthHeader = request.headers.get("content-length");
  if (
    contentLengthHeader === null ||
    !CONTENT_LENGTH_BYTES_PATTERN.test(contentLengthHeader)
  ) {
    return false;
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength)) {
    return false;
  }
  return bytesRead < contentLength;
}

/**
 * Named so the span attribution this feeds can tell a client disconnect apart
 * from a genuine route fault (ISS-8688). `errorResponse` records a cause for
 * every 5xx, and `resolveSpanErrorType` reads an own `name`; a bare `Error`
 * here would land in the RCA population as an unfilterable `Error`.
 */
class RequestBodyTruncatedError extends Error {
  name = "RequestBodyTruncatedError";

  constructor() {
    super("Request body ended before its declared Content-Length");
  }
}

/**
 * The error a bounded reader should answer a short read with, or `null` when
 * the body arrived whole. Shared so `parseBody` and the desktop write lanes —
 * which read bodies through their own helpers and never reach `parseBody` —
 * classify a truncated body identically.
 */
export function requestBodyTruncationError(
  request: Request,
  bytesRead: number
): unknown {
  if (!requestBodyWasTruncated(request, bytesRead)) {
    return null;
  }
  return request.signal?.reason ?? new RequestBodyTruncatedError();
}

function requestBodyReadFailureResult(error: unknown): ParseBodyResult<never> {
  return {
    body: null,
    rawBody: undefined,
    errorResponse: errorResponse("Failed to read request body", error),
  };
}

function requestBodyParseFailureResult(error: unknown): ParseBodyResult<never> {
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

/**
 * The message every `request_completed` line carries. The `api.requests.*`
 * log-based metrics and the `cl-api` log monitors match it by phrase, so it is
 * declared once and read by the emitter and its tests alike.
 */
export const REQUEST_COMPLETED_EVENT = "request_completed";
