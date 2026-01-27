/**
 * Custom error class for API errors.
 * Thrown by useApiClient when the API returns an error response.
 */
export class ApiError extends Error {
  readonly name = "ApiError";
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
