import { Priority as SharedPriority } from "@closedloop-ai/loops-api/common";

/**
 * JSON-compatible types for API input/output
 * These match Prisma's JsonValue types
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

/**
 * Discriminated union for API responses
 * Use this for all API responses to ensure consistent error handling
 */
export type ApiResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      code?: string;
      details?: JsonObject;
      timestamp?: string;
    };

/**
 * Helper to create a success result
 */
export function success<T>(data: T): ApiResult<T> {
  return { success: true, data };
}

/**
 * Helper to create an error result.
 *
 * Optional metadata is additive so existing `failure(error)` callers and
 * clients that only read `error` remain compatible.
 */
export function failure(
  error: string,
  options?: { code?: string; details?: JsonObject; timestamp?: string }
): ApiResult<never> {
  return {
    success: false,
    error,
    ...(options?.code ? { code: options.code } : {}),
    ...(options?.details ? { details: options.details } : {}),
    ...(options?.timestamp ? { timestamp: options.timestamp } : {}),
  };
}

/**
 * Wire shape for 409 conflict responses that carry a typed discriminant body
 * (e.g. multi-target compute, backend mismatch, loop already active).
 *
 * Extends the failure variant of `ApiResult` with a typed `data` field.
 * This is intentionally a separate type rather than a second generic on
 * `ApiResult`: NextResponse is invariant in its body parameter, so
 * propagating an extra type parameter through every auth wrapper would
 * require touching every route. Instead, conflict-emitting routes cast to
 * `NextResponse<ApiResult<never>>` at the framework boundary while
 * constructing the body via `conflictBody()` so both producer and consumer
 * agree on the exact shape and field names.
 */
export type ApiConflictBody<F> = {
  success: false;
  error: string;
  data: F;
};

/**
 * Helper to construct a 409 conflict response body. Pair with `NextResponse.json`
 * + a 409 status; the response is typed as `NextResponse<ApiResult<never>>` so
 * standard auth wrappers accept it.
 */
export function conflictBody<F>(error: string, data: F): ApiConflictBody<F> {
  return { success: false, error, data };
}
export const Priority = SharedPriority;
export type Priority = (typeof Priority)[keyof typeof Priority];
