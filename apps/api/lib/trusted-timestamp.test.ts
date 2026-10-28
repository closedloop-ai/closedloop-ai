import { describe, expect, it } from "vitest";
import {
  isWithinTrustedFutureBoundary,
  MAX_TRUSTED_FUTURE_SKEW_MS,
} from "./trusted-timestamp";

const TRUSTED_INSTANT = new Date("2026-08-22T12:00:00.000Z");
const at = (offsetMs: number) => new Date(TRUSTED_INSTANT.getTime() + offsetMs);

describe("MAX_TRUSTED_FUTURE_SKEW_MS", () => {
  it("tolerates exactly one day of producer clock lead", () => {
    expect(MAX_TRUSTED_FUTURE_SKEW_MS).toBe(86_400_000);
  });
});

describe("isWithinTrustedFutureBoundary", () => {
  it.each([
    ["far in the past", -365 * MAX_TRUSTED_FUTURE_SKEW_MS],
    ["one millisecond in the past", -1],
    ["exactly the trusted instant", 0],
    ["inside the skew window", MAX_TRUSTED_FUTURE_SKEW_MS - 1],
  ])("accepts a value %s", (_label, offsetMs) => {
    expect(isWithinTrustedFutureBoundary(at(offsetMs), TRUSTED_INSTANT)).toBe(
      true
    );
  });

  it("accepts the exact skew boundary", () => {
    expect(
      isWithinTrustedFutureBoundary(
        at(MAX_TRUSTED_FUTURE_SKEW_MS),
        TRUSTED_INSTANT
      )
    ).toBe(true);
  });

  it("rejects one millisecond beyond the boundary", () => {
    expect(
      isWithinTrustedFutureBoundary(
        at(MAX_TRUSTED_FUTURE_SKEW_MS + 1),
        TRUSTED_INSTANT
      )
    ).toBe(false);
  });

  it("rejects a value far beyond the boundary", () => {
    expect(
      isWithinTrustedFutureBoundary(
        at(365 * MAX_TRUSTED_FUTURE_SKEW_MS),
        TRUSTED_INSTANT
      )
    ).toBe(false);
  });

  it("rejects an invalid date rather than letting NaN slip through", () => {
    expect(
      isWithinTrustedFutureBoundary(new Date("not-a-date"), TRUSTED_INSTANT)
    ).toBe(false);
  });

  it("moves the window with the trusted instant, not the wall clock", () => {
    const value = at(2 * MAX_TRUSTED_FUTURE_SKEW_MS);
    expect(isWithinTrustedFutureBoundary(value, TRUSTED_INSTANT)).toBe(false);
    expect(
      isWithinTrustedFutureBoundary(value, at(MAX_TRUSTED_FUTURE_SKEW_MS))
    ).toBe(true);
  });
});
