import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSessionDateRange } from "../format-session-date-range";

declare const process: {
  env: {
    TZ?: string;
  };
};

describe("formatSessionDateRange", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    restoreTimeZone(originalTz);
  });

  it("returns null when either bound is missing (graceful empty state)", () => {
    expect(formatSessionDateRange(null, null)).toBeNull();
    expect(formatSessionDateRange("2026-06-01T00:00:00.000Z", null)).toBeNull();
    expect(formatSessionDateRange(null, "2026-06-17T00:00:00.000Z")).toBeNull();
  });

  it("returns null for unparseable bounds rather than 'Invalid Date'", () => {
    expect(formatSessionDateRange("not-a-date", "also-bad")).toBeNull();
  });

  it("collapses a same-day span to a single full date", () => {
    expect(
      formatSessionDateRange(
        "2026-06-17T01:00:00.000Z",
        "2026-06-17T23:00:00.000Z"
      )
    ).toBe("Jun 17, 2026");
  });

  it("shows the year once when both ends share a year", () => {
    expect(
      formatSessionDateRange(
        "2026-06-01T12:00:00.000Z",
        "2026-06-17T12:00:00.000Z"
      )
    ).toBe("Jun 1 – Jun 17, 2026");
  });

  it("carries the year on both ends when the span crosses years", () => {
    expect(
      formatSessionDateRange(
        "2025-12-30T12:00:00.000Z",
        "2026-01-02T12:00:00.000Z"
      )
    ).toBe("Dec 30, 2025 – Jan 2, 2026");
  });

  it("collapses near-midnight UTC instants by the New York local date", () => {
    process.env.TZ = "America/New_York";

    expect(
      formatSessionDateRange(
        "2026-01-01T01:00:00.000Z",
        "2026-01-01T03:00:00.000Z"
      )
    ).toBe("Dec 31, 2025");
  });

  it("spans near-midnight UTC instants by the Tokyo local date", () => {
    process.env.TZ = "Asia/Tokyo";

    expect(
      formatSessionDateRange(
        "2026-01-01T14:00:00.000Z",
        "2026-01-01T16:00:00.000Z"
      )
    ).toBe("Jan 1 – Jan 2, 2026");
  });
});
