import { describe, expect, it } from "vitest";
import { failure } from "./common.ts";

describe("failure", () => {
  it("omits optional failure metadata by default", () => {
    expect(failure("request failed")).toEqual({
      success: false,
      error: "request failed",
    });
  });

  it("includes supplied failure metadata", () => {
    expect(
      failure("request failed", {
        code: "request_failed",
        details: { retryable: true },
        timestamp: "2026-08-08T00:00:00.000Z",
      })
    ).toEqual({
      success: false,
      error: "request failed",
      code: "request_failed",
      details: { retryable: true },
      timestamp: "2026-08-08T00:00:00.000Z",
    });
  });
});
