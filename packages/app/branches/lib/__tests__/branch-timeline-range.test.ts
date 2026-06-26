import { describe, expect, it } from "vitest";
import {
  formatClock,
  fractionOf,
  hourRange,
  timeRange,
} from "../branch-timeline-range";

const HOUR_MS = 3_600_000;

describe("hourRange", () => {
  it("returns null for an empty input", () => {
    expect(hourRange([])).toBeNull();
  });

  it("returns null when nothing parses", () => {
    expect(hourRange(["not-a-date", "also bad"])).toBeNull();
  });

  it("spans from the first hour start to the last hour start + 1h", () => {
    const a = "2026-01-05T10:00:00.000Z";
    const b = "2026-01-05T13:00:00.000Z";
    const range = hourRange([b, a]);
    expect(range).not.toBeNull();
    expect(range?.startMs).toBe(Date.parse(a));
    expect(range?.endMs).toBe(Date.parse(b) + HOUR_MS);
    expect(range?.spanMs).toBe(Date.parse(b) + HOUR_MS - Date.parse(a));
  });

  it("skips NaN entries but keeps valid ones", () => {
    const a = "2026-01-05T10:00:00.000Z";
    const range = hourRange(["bad", a, "worse"]);
    expect(range?.startMs).toBe(Date.parse(a));
    expect(range?.endMs).toBe(Date.parse(a) + HOUR_MS);
  });
});

describe("timeRange", () => {
  it("returns null when no starts parse", () => {
    expect(timeRange(["bad"], [])).toBeNull();
  });

  it("folds starts into the max so a null end still bounds the range", () => {
    const start = "2026-01-05T10:00:00.000Z";
    const range = timeRange([start], [null]);
    expect(range?.startMs).toBe(Date.parse(start));
    expect(range?.endMs).toBe(Date.parse(start));
    expect(range?.spanMs).toBe(1);
  });

  it("uses the max end across parsed ends", () => {
    const start = "2026-01-05T10:00:00.000Z";
    const end = "2026-01-05T12:00:00.000Z";
    const range = timeRange([start], [null, end, "bad"]);
    expect(range?.startMs).toBe(Date.parse(start));
    expect(range?.endMs).toBe(Date.parse(end));
  });
});

describe("fractionOf", () => {
  const range = { startMs: 0, endMs: 100, spanMs: 100 };

  it("maps a midpoint to 0.5", () => {
    expect(fractionOf(range, 50)).toBe(0.5);
  });

  it("clamps below the start to 0 and above the end to 1", () => {
    expect(fractionOf(range, -10)).toBe(0);
    expect(fractionOf(range, 250)).toBe(1);
  });
});

describe("formatClock", () => {
  it("drops minutes on the hour and uses am/pm (local time)", () => {
    // Jan 5 2026 is a Monday. Use the local-time constructor so the assertion
    // matches formatClock's local getters regardless of the runner's TZ.
    const onTheHour = new Date(2026, 0, 5, 14, 0).getTime();
    expect(formatClock(onTheHour)).toBe("Mon 2pm");
  });

  it("includes zero-padded minutes when not on the hour", () => {
    const withMinutes = new Date(2026, 0, 5, 9, 5).getTime();
    expect(formatClock(withMinutes)).toBe("Mon 9:05am");
  });

  it("renders midnight as 12am", () => {
    const midnight = new Date(2026, 0, 5, 0, 0).getTime();
    expect(formatClock(midnight)).toBe("Mon 12am");
  });
});
