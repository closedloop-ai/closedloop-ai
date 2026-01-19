import type { ApiResult } from "@repo/api/src/types/common";
import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Standard route params type for [id] routes.
 */
export type RouteParams<T extends string = "id"> = {
  params: Promise<{ [K in T]: string }>;
};

/**
 * Parse and validate request body against a zod schema.
 * Returns the validated data or a NextResponse error.
 */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<z.infer<T> | NextResponse<ApiResult<never>>> {
  try {
    const rawBody = await request.json();
    const parseResult = schema.safeParse(rawBody);

    if (!parseResult.success) {
      const errorMessage = parseResult.error.issues
        .map((issue) => issue.message)
        .join(", ");
      return NextResponse.json(failure(errorMessage), { status: 400 });
    }

    return parseResult.data;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to parse request body:", errorMessage);
    return NextResponse.json(failure("Invalid JSON body"), { status: 400 });
  }
}

/**
 * Check if the result of parseBody is an error response.
 */
export function isErrorResponse<T>(
  result: T | NextResponse<ApiResult<never>>
): result is NextResponse<ApiResult<never>> {
  return result instanceof NextResponse;
}

/**
 * Create a standardized error response with sanitized logging.
 */
export function errorResponse(
  message: string,
  error: unknown,
  status = 500
): NextResponse<ApiResult<never>> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`${message}:`, errorMessage);
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
 * Create a standard delete success response.
 */
export function deleteResponse(): NextResponse<ApiResult<{ deleted: true }>> {
  return NextResponse.json(success({ deleted: true }));
}
