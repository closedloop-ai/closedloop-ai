import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureDate,
  formatDate,
  formatDateCompact,
  formatDateForInput,
  formatDateTime,
  formatDateTimeOrFallback,
  formatRelativeTime,
  formatRelativeTimeOrFallback,
  formatTime,
  formatTimeOrFallback,
  parseDateLocal,
} from "../date-utils";

describe("parseDateLocal", () => {
  it("parses a date-only string as local midnight (no timezone shift)", () => {
    const result = parseDateLocal("2026-03-12");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(2); // March, zero-indexed
    expect(result.getDate()).toBe(12);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it("parses a full ISO string as the encoded instant", () => {
    expect(parseDateLocal("2026-03-12T15:30:00Z").toISOString()).toBe(
      "2026-03-12T15:30:00.000Z"
    );
  });
});

describe("ensureDate", () => {
  it("returns null for null, undefined, and empty string", () => {
    expect(ensureDate(null)).toBeNull();
    expect(ensureDate(undefined)).toBeNull();
    expect(ensureDate("")).toBeNull();
  });

  it("parses a date-only string via parseDateLocal", () => {
    const result = ensureDate("2026-03-12");
    expect(result?.getFullYear()).toBe(2026);
    expect(result?.getMonth()).toBe(2);
    expect(result?.getDate()).toBe(12);
  });

  it("passes a Date through unchanged", () => {
    const input = new Date(2026, 2, 12);
    expect(ensureDate(input)).toBe(input);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ago = (ms: number) => new Date(now.getTime() - ms);
  const fromNow = (ms: number) => new Date(now.getTime() + ms);

  it("returns 'Just now' for under a minute", () => {
    expect(formatRelativeTime(ago(30_000))).toBe("Just now");
  });

  it("handles the singular and plural minute thresholds", () => {
    expect(formatRelativeTime(ago(60_000))).toBe("1 min ago");
    expect(formatRelativeTime(ago(5 * 60_000))).toBe("5 min ago");
  });

  it("handles the singular and plural hour thresholds", () => {
    expect(formatRelativeTime(ago(90 * 60_000))).toBe("1 hour ago");
    expect(formatRelativeTime(ago(3 * 3_600_000))).toBe("3 hours ago");
  });

  it("returns 'Yesterday' then 'N days ago' under a week", () => {
    expect(formatRelativeTime(ago(25 * 3_600_000))).toBe("Yesterday");
    expect(formatRelativeTime(ago(3 * 86_400_000))).toBe("3 days ago");
  });

  it("falls back to an absolute date at one week or more", () => {
    expect(formatRelativeTime(ago(10 * 86_400_000))).toBe("Jun 5, 2026");
  });

  it("formats future timestamps as upcoming relative labels", () => {
    expect(formatRelativeTime(fromNow(30_000))).toBe("Just now");
    expect(formatRelativeTime(fromNow(60_000))).toBe("1 min from now");
    expect(formatRelativeTime(fromNow(5 * 60_000))).toBe("5 min from now");
    expect(formatRelativeTime(fromNow(90 * 60_000))).toBe("1 hour from now");
    expect(formatRelativeTime(fromNow(3 * 3_600_000))).toBe("3 hours from now");
    expect(formatRelativeTime(fromNow(25 * 3_600_000))).toBe("Tomorrow");
    expect(formatRelativeTime(fromNow(3 * 86_400_000))).toBe("3 days from now");
    expect(formatRelativeTime(fromNow(10 * 86_400_000))).toBe("Jun 25, 2026");
  });

  it("returns fallback labels for invalid untrusted relative timestamps", () => {
    expect(formatRelativeTimeOrFallback("not-a-date")).toBe("not-a-date");
    expect(
      formatRelativeTimeOrFallback(undefined, { fallback: "Unknown" })
    ).toBe("Unknown");
  });
});

describe("absolute date formatters", () => {
  const date = new Date(2026, 0, 14, 15, 30);
  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    restoreTimeZone(originalTz);
  });

  it("formats a long date", () => {
    expect(formatDate(date)).toBe("Jan 14, 2026");
  });

  it("formats a compact date", () => {
    expect(formatDateCompact(date)).toBe("1/14/26");
  });

  it("formats a date with time", () => {
    expect(formatDateTime(date)).toBe("Jan 14, 2026 at 3:30 PM");
  });

  it("formats the same UTC instant in the viewer's local time zone", () => {
    process.env.TZ = "America/New_York";
    expect(formatDate("2026-01-01T01:30:00.000Z")).toBe("Dec 31, 2025");
    expect(formatDateTime("2026-01-01T01:30:00.000Z")).toBe(
      "Dec 31, 2025 at 8:30 PM"
    );

    process.env.TZ = "Asia/Tokyo";
    expect(formatDate("2026-01-01T01:30:00.000Z")).toBe("Jan 1, 2026");
    expect(formatDateTime("2026-01-01T01:30:00.000Z")).toBe(
      "Jan 1, 2026 at 10:30 AM"
    );
  });

  it("uses the viewer-local absolute date for relative fallback labels", () => {
    process.env.TZ = "America/New_York";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z"));

    expect(formatRelativeTime("2026-01-01T01:30:00.000Z")).toBe("Dec 31, 2025");

    vi.useRealTimers();
  });

  it("formats viewer-local time without seconds by default", () => {
    process.env.TZ = "America/New_York";
    expect(formatTime("2026-01-01T01:30:45.000Z")).toBe("8:30 PM");
  });

  it("formats viewer-local time with two-digit seconds when requested", () => {
    process.env.TZ = "America/New_York";
    expect(
      formatTime("2026-01-01T01:30:05.000Z", { includeSeconds: true })
    ).toBe("8:30:05 PM");
  });

  it("preserves 24-hour diagnostic time when requested", () => {
    process.env.TZ = "America/New_York";
    expect(
      formatTime("2026-01-01T19:30:05.000Z", {
        hour12: false,
        includeSeconds: true,
      })
    ).toBe("14:30:05");
    expect(
      formatTimeOrFallback("2026-01-01T19:30:05.000Z", {
        hour12: false,
        includeSeconds: true,
      })
    ).toBe("14:30:05");
  });

  it("returns the original non-empty string for invalid untrusted time input", () => {
    expect(formatTimeOrFallback("not-a-date")).toBe("not-a-date");
  });

  it("returns the explicit fallback for missing untrusted time input", () => {
    expect(formatTimeOrFallback(undefined, { fallback: "Unknown" })).toBe(
      "Unknown"
    );
  });

  it("returns fallback labels for invalid untrusted date-time input", () => {
    expect(formatDateTimeOrFallback("not-a-date")).toBe("not-a-date");
    expect(formatDateTimeOrFallback(undefined, { fallback: "Unknown" })).toBe(
      "Unknown"
    );
  });

  it("formats a date for an input field", () => {
    expect(formatDateForInput(date)).toBe("2026-01-14");
  });

  it("accepts a date-only string input", () => {
    expect(formatDate("2026-01-14")).toBe("Jan 14, 2026");
  });
});
