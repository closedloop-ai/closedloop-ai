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
  | { success: false; error: string };

/**
 * Helper to create a success result
 */
export function success<T>(data: T): ApiResult<T> {
  return { success: true, data };
}

/**
 * Helper to create an error result
 */
export function failure(error: string): ApiResult<never> {
  return { success: false, error };
}
