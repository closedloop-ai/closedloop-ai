import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import type { z } from "zod";

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
  validator: T
): Promise<ParseBodyResult<z.infer<T>>> {
  try {
    const rawBody = await request.json();
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
    const errorMessage = parseError(error);
    log.error("Failed to parse request body:", { error: errorMessage });
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
  const queryParams = Object.fromEntries(
    request.nextUrl.searchParams.entries()
  );
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
 * Create a standardized error response with sanitized logging.
 * Calls scheduleLogFlush() internally — callers must not add a redundant flush.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500,
  metadata?: ErrorResponseMetadata
): NextResponse<ApiResult<never>> {
  const errorMessage = parseError(error);
  log.error(message, { error: errorMessage });
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
  scheduleLogFlush();
}

type ErrorResponseMetadata = {
  code?: string;
  details?: JsonObject;
  timestamp?: string;
};
