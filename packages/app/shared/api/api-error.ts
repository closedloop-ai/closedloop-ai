import type { JsonObject } from "@repo/api/src/types/common";
import type {
  FriendlyErrorDetails,
  FriendlyErrorOutput,
} from "@repo/api/src/types/friendly-error";
import { resolveFriendlyError } from "@repo/api/src/types/friendly-error";
import { API_TIMEOUT_ERROR_CODE } from "./api-timeout";

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

  /**
   * Check if the client gave up waiting for a response (ISS-5013).
   *
   * Deliberately distinct from {@link isServerError} and {@link isClientError}:
   * a timeout means no answer was ever received, NOT that the server answered
   * with a failure. A surface that renders "the server rejected this" for a
   * request that simply never came back is telling the user something untrue,
   * so the two states are separable here rather than collapsed into one
   * "request failed".
   */
  isTimeout(): boolean {
    return this.code === API_TIMEOUT_ERROR_CODE;
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
    // ISS-5013: a client deadline is NOT in the server-owned `LoopErrorCode`
    // vocabulary, so `resolveFriendlyError` would fall through to the generic
    // "Operation failed / The operation did not complete." — a request the
    // CLIENT abandoned told as an assertion about what the server did. The
    // server may well have finished; say only what we actually know.
    if (error.isTimeout()) {
      return {
        ...API_TIMEOUT_FRIENDLY_ERROR,
        code: error.code,
        timestamp: error.timestamp,
        technicalDetails: buildTimeoutTechnicalDetails(error),
      };
    }
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

/**
 * Display copy for a request the client stopped waiting on (ISS-5013).
 *
 * Deliberately does not claim the operation failed: the deadline is ours, the
 * request may have committed server-side, and several of the endpoints behind
 * it are idempotent and commit under a lock. "We stopped waiting" is the only
 * fact available at this point, so it is the only one stated.
 */
const API_TIMEOUT_FRIENDLY_ERROR: FriendlyErrorDetails = {
  title: "We stopped waiting",
  description:
    "This took longer than expected, so we stopped waiting for a response. It may still be finishing.",
  remediation: [
    "Give it a moment, then refresh to see whether it completed.",
    "Try again if nothing changed.",
  ],
};

/** Technical details for a deadline abort: no server payload ever arrived. */
function buildTimeoutTechnicalDetails(error: ApiError): JsonObject {
  const details: JsonObject = { message: error.message };
  if (error.code !== undefined) {
    details.code = error.code;
  }
  if (error.timestamp !== undefined) {
    details.timestamp = error.timestamp;
  }
  return details;
}
