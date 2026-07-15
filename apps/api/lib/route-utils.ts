import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { emitRequestCompletedSpan } from "@repo/observability/telemetry/request-completed";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
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
 */
export type ParseBodyResult<T> =
  | { body: T; errorResponse: null }
  | { body: null; errorResponse: NextResponse<ApiResult<never>> };

export type ParseBodyOptions = {
  /** Maximum allowed UTF-8 request body size in bytes. */
  maxBytes?: number;
};

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
    const bodyText = await request.text();
    if (
      options.maxBytes !== undefined &&
      new TextEncoder().encode(bodyText).byteLength > options.maxBytes
    ) {
      return {
        body: null,
        errorResponse: NextResponse.json(failure("Request body too large"), {
          status: 413,
        }),
      };
    }

    const rawBody = JSON.parse(bodyText) as unknown;
    const parseResult = validator.safeParse(rawBody);

    if (!parseResult.success) {
      return {
        body: null,
        errorResponse: badRequestResponse(
          formatZodErrors(parseResult.error.issues)
        ),
      };
    }

    return { body: parseResult.data, errorResponse: null };
  } catch (error) {
    log.error("Failed to parse request body:", { error });
    scheduleLogFlush();
    return {
      body: null,
      errorResponse: NextResponse.json(failure("Invalid JSON body"), {
        status: 400,
      }),
    };
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
  const queryParams: Record<string, string | string[]> = {};
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
 * Format Zod validation issues into a human-readable error string.
 * Includes field paths so callers know which fields failed.
 */
function formatZodErrors(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
}

export function scheduleLogFlush(): void {
  waitUntil(log.flush().catch(() => {}));
}

export function scheduleLogFlushAfter(promise: Promise<unknown>): void {
  waitUntil(promise.finally(() => log.flush().catch(() => {})));
}

/**
 * Emit a single `request_completed` log line for the given request/response
 * pair. Field names are the snake_case attributes the Datadog log-based
 * generators (api.requests.count, api.errors.count, api.requests.latency)
 * group on. `scheduleLogFlush()` is invoked so the log reaches Datadog before
 * the serverless function freezes.
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
    path: new URL(request.url).pathname,
    method: request.method,
    status_code: statusCode,
    duration_ms: durationMs,
  });
  emitRequestCompletedSpan({
    requestUrl: request.url,
    method: request.method,
    statusCode,
    durationMs,
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
