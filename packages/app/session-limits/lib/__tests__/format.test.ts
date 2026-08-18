import { describe, expect, it } from "vitest";
import {
  formatCreditSummary,
  formatFetchedAtLabel,
  formatResetLabel,
  formatSourceLabel,
  formatUsedLabel,
} from "../format";

describe("formatUsedLabel", () => {
  it("floors the percentage like the CLI display", () => {
    expect(formatUsedLabel(42.9)).toBe("42% used");
    expect(formatUsedLabel(0)).toBe("0% used");
    expect(formatUsedLabel(150)).toBe("100% used");
  });
});

describe("formatResetLabel", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");

  it("returns null for missing/unparseable timestamps", () => {
    expect(formatResetLabel(null, now)).toBeNull();
    expect(formatResetLabel("not-a-date", now)).toBeNull();
  });

  it("formats minutes, hours, and days out", () => {
    expect(formatResetLabel("2026-07-19T12:45:00.000Z", now)).toBe("in 45m");
    expect(formatResetLabel("2026-07-19T15:00:00.000Z", now)).toBe("in 3h");
    expect(formatResetLabel("2026-07-21T12:00:00.000Z", now)).toBe("in 2d");
  });

  it("returns 'now' for a past or current reset", () => {
    expect(formatResetLabel("2026-07-19T11:00:00.000Z", now)).toBe("now");
  });
});

describe("formatCreditSummary", () => {
  it("summarizes used vs limit, handling unlimited and unknown", () => {
    expect(formatCreditSummary(3.5, 20)).toBe("$3.50 of $20.00");
    expect(formatCreditSummary(3.5, null)).toBe("$3.50 used");
    expect(formatCreditSummary(null, 20)).toBeNull();
  });
});

describe("formatSourceLabel", () => {
  it("labels each known producer and omits unknown", () => {
    expect(formatSourceLabel("usage_api")).toBe("Usage endpoint");
    expect(formatSourceLabel("statusline")).toBe("Statusline");
    expect(formatSourceLabel("rate_limit_event")).toBe("Rate-limit event");
    expect(formatSourceLabel(null)).toBeNull();
    expect(formatSourceLabel(undefined)).toBeNull();
  });
});

describe("formatFetchedAtLabel", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");

  it("returns null for missing/unparseable timestamps", () => {
    expect(formatFetchedAtLabel(null, now)).toBeNull();
    expect(formatFetchedAtLabel("not-a-date", now)).toBeNull();
  });

  it("formats sub-minute, minutes, hours, and days", () => {
    expect(formatFetchedAtLabel("2026-07-19T11:59:30.000Z", now)).toBe(
      "just now"
    );
    expect(formatFetchedAtLabel("2026-07-19T11:55:00.000Z", now)).toBe(
      "5m ago"
    );
    expect(formatFetchedAtLabel("2026-07-19T09:00:00.000Z", now)).toBe(
      "3h ago"
    );
    expect(formatFetchedAtLabel("2026-07-17T12:00:00.000Z", now)).toBe(
      "2d ago"
    );
  });

  it("reads a future timestamp (clock skew) as 'just now'", () => {
    expect(formatFetchedAtLabel("2026-07-19T12:05:00.000Z", now)).toBe(
      "just now"
    );
  });
});
