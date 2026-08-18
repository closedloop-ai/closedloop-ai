/**
 * ISS-5013: a request the CLIENT abandoned must not be told as an assertion
 * about what the SERVER did.
 *
 * `client_request_timeout` is not in the server-owned `LoopErrorCode`
 * vocabulary, so `resolveFriendlyError` falls through to its generic
 * "Operation failed / The operation did not complete." template. That copy
 * reaches the user verbatim through the shared `mutations.onError` toast — and
 * several of the endpoints behind this deadline are idempotent and commit under
 * a lock, so the operation may well have completed. These pin the split.
 */

import { describe, expect, it } from "vitest";
import { ApiError, getFriendlyError } from "../api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../api-timeout";

const GENERIC_FALLBACK_TITLE = "Operation failed";
const GENERIC_FALLBACK_DESCRIPTION = "The operation did not complete.";

function timeoutError(): ApiError {
  return new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
    code: API_TIMEOUT_ERROR_CODE,
  });
}

describe("getFriendlyError for a client-deadline timeout", () => {
  it("never claims the operation did not complete", () => {
    const friendly = getFriendlyError(timeoutError());

    expect(friendly.title).not.toBe(GENERIC_FALLBACK_TITLE);
    expect(friendly.description).not.toContain(GENERIC_FALLBACK_DESCRIPTION);
  });

  it("states that we stopped waiting and that the work may still be finishing", () => {
    const friendly = getFriendlyError(timeoutError());

    expect(friendly.title).toBe("We stopped waiting");
    expect(friendly.description).toContain("may still be finishing");
    expect(friendly.remediation.length).toBeGreaterThan(0);
  });

  it("carries the timeout code through for debugging", () => {
    const friendly = getFriendlyError(timeoutError());

    expect(friendly.code).toBe(API_TIMEOUT_ERROR_CODE);
    expect(friendly.technicalDetails).toMatchObject({
      code: API_TIMEOUT_ERROR_CODE,
      message: API_TIMEOUT_ERROR_MESSAGE,
    });
  });

  it("leaves a server-answered failure on the canonical resolver", () => {
    // The timeout branch must not swallow errors the server actually answered.
    const friendly = getFriendlyError(
      new ApiError("Catalog is unavailable", 500)
    );

    expect(friendly.title).not.toBe("We stopped waiting");
  });
});
