import { describe, expect, it } from "vitest";
import { isRetryableDatadogStatus } from "../datadog-retry";

describe("isRetryableDatadogStatus", () => {
  it("retries a request timeout", () => {
    expect(isRetryableDatadogStatus(408)).toBe(true);
  });

  it.each([
    [429, true],
    [500, true],
    [599, true],
    [400, false],
    [499, false],
  ])("classifies status %i as retryable=%s", (status, expected) => {
    expect(isRetryableDatadogStatus(status)).toBe(expected);
  });
});
