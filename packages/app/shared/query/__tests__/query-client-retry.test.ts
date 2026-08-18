/**
 * Retry-policy contract for the shared query client (FEA-3940). An auth
 * failure (401/403) — or any error that carried an HTTP response — must fail
 * fast with zero retries so the degraded/re-auth surface takes over instead of
 * the client hammering a bricked API; only a bare network error retries, and
 * only up to a small cap with capped exponential backoff.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error";
import {
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../api/api-timeout";
import {
  isResponseBackedError,
  MAX_TRANSIENT_QUERY_RETRIES,
  QUERY_RETRY_MAX_DELAY_MS,
  queryRetryDelay,
  shouldRetryQuery,
} from "../query-client";

/** A non-ApiError that still carries an HTTP status (e.g. LivePrOverlayError). */
class StatusBackedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

describe("shouldRetryQuery", () => {
  // ISS-5013: a client-deadline timeout carries no HTTP response, so it would
  // otherwise look like a retryable transport blip. Retrying it means another
  // full-length wait per attempt — minutes of a surface still claiming to load,
  // which is exactly what the deadline exists to end. Pinned so the decision
  // stays deliberate rather than an accident of `isResponseBackedError`.
  it("does not retry a client-deadline timeout", () => {
    const error = new ApiError(API_TIMEOUT_ERROR_MESSAGE, 0, {
      code: API_TIMEOUT_ERROR_CODE,
    });
    expect(error.isTimeout()).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("does not retry a 401 auth failure", () => {
    const error = new ApiError("Unauthorized", 401);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("does not retry a 403 forbidden failure", () => {
    const error = new ApiError("Forbidden", 403);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("does not retry other client errors (4xx)", () => {
    const error = new ApiError("Not found", 404);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("does not retry server errors (5xx)", () => {
    const error = new ApiError("Server error", 500);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it("does not retry a non-ApiError that carries an HTTP status", () => {
    // A LivePrOverlayError-shaped 403 (or any response-backed error) already
    // has the server's answer — it must fail fast just like an ApiError.
    expect(shouldRetryQuery(0, new StatusBackedError("Forbidden", 403))).toBe(
      false
    );
    // A runner-token plain Error with a 401 status is likewise terminal.
    expect(shouldRetryQuery(0, new StatusBackedError("no token", 401))).toBe(
      false
    );
  });

  it("retries a status-zero transport error (no HTTP response)", () => {
    // `status === 0` is the fetch "no response" sentinel — a genuine transport
    // failure that stays retryable.
    const error = new StatusBackedError("network down", 0);
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(MAX_TRANSIENT_QUERY_RETRIES, error)).toBe(false);
  });

  it("retries a bare network error up to the cap, then stops", () => {
    const error = new TypeError("Failed to fetch");
    // Retries while under the cap...
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(MAX_TRANSIENT_QUERY_RETRIES - 1, error)).toBe(true);
    // ...and stops once the cap is reached.
    expect(shouldRetryQuery(MAX_TRANSIENT_QUERY_RETRIES, error)).toBe(false);
    expect(shouldRetryQuery(MAX_TRANSIENT_QUERY_RETRIES + 1, error)).toBe(
      false
    );
  });
});

describe("isResponseBackedError", () => {
  it("recognizes an ApiError", () => {
    expect(isResponseBackedError(new ApiError("Unauthorized", 401))).toBe(true);
  });

  it("recognizes any error carrying a real HTTP status", () => {
    expect(isResponseBackedError(new StatusBackedError("Forbidden", 403))).toBe(
      true
    );
  });

  it("treats status 0 and bare/plain errors as transport (not response-backed)", () => {
    expect(isResponseBackedError(new StatusBackedError("down", 0))).toBe(false);
    expect(isResponseBackedError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isResponseBackedError(null)).toBe(false);
    expect(isResponseBackedError({ status: "nope" })).toBe(false);
  });
});

describe("queryRetryDelay", () => {
  it("grows exponentially from the base delay", () => {
    expect(queryRetryDelay(0)).toBe(1000);
    expect(queryRetryDelay(1)).toBe(2000);
    expect(queryRetryDelay(2)).toBe(4000);
  });

  it("clamps at the max delay ceiling", () => {
    expect(queryRetryDelay(20)).toBe(QUERY_RETRY_MAX_DELAY_MS);
  });
});
