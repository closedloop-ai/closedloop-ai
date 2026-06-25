import type { JsonObject } from "@repo/api/src/types/common";
import type { FriendlyErrorOutput } from "@repo/api/src/types/friendly-error";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";

export type ApiErrorOptions = {
  code?: string;
  data?: unknown;
  details?: JsonObject;
  timestamp?: string;
};

/**
 * Custom error class for API errors.
 * Thrown by useApiClient when the API returns an error response.
 */
export class ApiError extends Error {
  readonly name = "ApiError";
  readonly status: number;
  readonly code?: string;
  readonly details?: JsonObject;
  readonly timestamp?: string;
  readonly data?: unknown;

  constructor(
    message: string,
    status: number,
    codeOrOptions?: string | ApiErrorOptions,
    data?: unknown
  ) {
    super(message);
    this.status = status;
    if (typeof codeOrOptions === "object" && codeOrOptions !== null) {
      this.code = codeOrOptions.code;
      this.details = codeOrOptions.details;
      this.timestamp = codeOrOptions.timestamp;
      this.data = codeOrOptions.data;
      return;
    }
    this.code = codeOrOptions;
    this.data = data;
  }

  /**
   * Check if the error is a client error (4xx status code).
   * These errors should not be retried.
   */
  isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * Check if the error is a server error (5xx status code).
   * These errors may be retried.
   */
  isServerError(): boolean {
    return this.status >= 500;
  }

  /**
   * Check if the error is a not found error (404).
   */
  isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * Check if the error is an authentication error (401).
   */
  isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * Check if the error is a forbidden error (403).
   */
  isForbidden(): boolean {
    return this.status === 403;
  }
}

/**
 * Get a user-friendly error message from an error object.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred";
}

/**
 * Resolve any app error into friendly display copy while preserving raw
 * messages inside technical details.
 */
export function getFriendlyError(error: unknown): FriendlyErrorOutput {
  if (error instanceof ApiError) {
    return resolveFriendlyError({
      code: error.code,
      details: error.details,
      message: error.message,
      timestamp: error.timestamp,
    });
  }
  if (error instanceof Error) {
    return resolveFriendlyError({ message: error.message });
  }
  return resolveFriendlyError({ message: "An unexpected error occurred" });
}
