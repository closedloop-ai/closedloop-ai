import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
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
      const errorMessage = parseResult.error.issues
        .map((issue) => issue.message)
        .join(", ");
      return {
        body: null,
        errorResponse: NextResponse.json(failure(errorMessage), {
          status: 400,
        }),
      };
    }

    return { body: parseResult.data, errorResponse: null };
  } catch (error) {
    const errorMessage = parseError(error);
    log.error("Failed to parse request body:", { error: errorMessage });
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
 * Returns an object with either body (on success) or errorResponse (on failure).
 *
 * @example
 * const { body, errorResponse } = parseQueryParams(request, myValidator);
 * if (errorResponse) return errorResponse;
 * // body is now typed as z.infer<typeof myValidator>
 *
 * @param request - NextRequest with searchParams
 * @param validator - Zod schema to validate against
 * @returns ParseBodyResult with typed body or error response
 */
export function parseQueryParams<T extends z.ZodType>(
  request: { nextUrl: { searchParams: URLSearchParams } },
  validator: T
): ParseBodyResult<z.infer<T>> {
  const queryParams = Object.fromEntries(
    request.nextUrl.searchParams.entries()
  );
  const parseResult = validator.safeParse(queryParams);

  if (!parseResult.success) {
    return {
      body: null,
      errorResponse: badRequestResponse(
        `Invalid query parameters: ${parseResult.error.message}`
      ),
    };
  }

  return { body: parseResult.data, errorResponse: null };
}

/**
 * Create a standardized error response with sanitized logging.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  const errorMessage = parseError(error);
  log.error(message, { error: errorMessage });
  return NextResponse.json(failure(message), { status });
}

/**
 * Create a bad request response.
 */
export function badRequestResponse(
  message: string
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(message), { status: 400 });
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
  entity: string
): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure(`${entity} not found`), { status: 404 });
}

/**
 * Create an unauthorized response.
 */
export function unauthorizedResponse(): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Unauthorized"), { status: 401 });
}

/**
 * Create a forbidden response.
 */
export function forbiddenResponse(): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Forbidden"), { status: 403 });
}

/**
 * Create a standard delete success response.
 */
export function deleteResponse(): NextResponse<ApiResult<{ deleted: true }>> {
  return NextResponse.json(success({ deleted: true }));
}
