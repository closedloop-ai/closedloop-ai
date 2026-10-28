import { formatTime } from "@repo/app/shared/lib/date-utils";
import { describe, expect, it } from "vitest";
import { formatMarkerTime } from "../session-marker-time";

describe("formatMarkerTime", () => {
  it("formats a Date instance using the shared time formatter with seconds", () => {
    const date = new Date("2026-06-01T14:44:05.000Z");

    expect(formatMarkerTime(date)).toBe(
      formatTime(date, { includeSeconds: true })
    );
  });

  it("formats a parseable ISO string the same way as its Date equivalent", () => {
    const iso = "2026-06-01T14:44:05.000Z";

    expect(formatMarkerTime(iso)).toBe(formatMarkerTime(new Date(iso)));
  });

  it("degrades to the original string when it cannot be parsed as a date", () => {
    expect(formatMarkerTime("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("returns an empty label for a non-string, non-Date value", () => {
    expect(formatMarkerTime(42)).toBe("");
    expect(formatMarkerTime(null)).toBe("");
    expect(formatMarkerTime(undefined)).toBe("");
    expect(formatMarkerTime({})).toBe("");
  });

  it("returns an empty label for an empty string (no text to fall back to that is meaningful, per the parse failure path)", () => {
    // "" fails Date parsing (NaN), so it takes the fallback-to-original-text
    // branch and returns the original (empty) string.
    expect(formatMarkerTime("")).toBe("");
  });
});
