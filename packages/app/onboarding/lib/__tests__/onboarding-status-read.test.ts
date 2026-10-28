import { describe, expect, it } from "vitest";
import { isOnboardingStatusReadFailing } from "../onboarding-status-read";

describe("isOnboardingStatusReadFailing", () => {
  it("is true for a terminal failure", () => {
    expect(
      isOnboardingStatusReadFailing({
        errorUpdateCount: 1,
        isError: true,
        isFetching: false,
      })
    ).toBe(true);
  });

  it("stays true while Retry re-reads a failure already on record", () => {
    expect(
      isOnboardingStatusReadFailing({
        errorUpdateCount: 1,
        isError: false,
        isFetching: true,
      })
    ).toBe(true);
  });

  it("is false for a first read that has never failed", () => {
    expect(
      isOnboardingStatusReadFailing({
        errorUpdateCount: 0,
        isError: false,
        isFetching: true,
      })
    ).toBe(false);
  });
});
