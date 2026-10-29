/**
 * ISS-7235 — "today as a time, earlier as MM/DD".
 *
 * A calendar-boundary rule, so the clock is pinned with fake timers rather than
 * read from the wall: a real-clock test passes every day until it is run within
 * a minute of local midnight, and rots exactly like a timing assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeOfDayOrMonthDay } from "../date-utils";

const NOON_TODAY = new Date(2026, 7, 21, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOON_TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatTimeOfDayOrMonthDay", () => {
  it("renders a same-day timestamp as a time of day", () => {
    expect(formatTimeOfDayOrMonthDay(new Date(2026, 7, 21, 9, 4))).toBe(
      "9:04 AM"
    );
  });

  it("renders yesterday as MM/DD, not as a time", () => {
    expect(formatTimeOfDayOrMonthDay(new Date(2026, 7, 20, 23, 59))).toBe(
      "08/20"
    );
  });

  it("zero-pads a single-digit month and day", () => {
    expect(formatTimeOfDayOrMonthDay(new Date(2026, 0, 5, 10, 0))).toBe(
      "01/05"
    );
  });

  it("crosses the boundary at local midnight, not at the hour before it", () => {
    const lateToday = new Date(2026, 7, 21, 23, 59);
    const earlyToday = new Date(2026, 7, 21, 0, 0);

    expect(formatTimeOfDayOrMonthDay(lateToday)).toBe("11:59 PM");
    expect(formatTimeOfDayOrMonthDay(earlyToday)).toBe("12:00 AM");
  });

  it("compares against an injected clock rather than the ambient one", () => {
    const contribution = new Date(2026, 7, 21, 9, 4);

    expect(
      formatTimeOfDayOrMonthDay(contribution, {
        now: new Date(2026, 7, 25, 12, 0),
      })
    ).toBe("08/21");
  });

  it("still reads today's date as a date when the viewer's clock moves on", () => {
    const contribution = new Date(2026, 7, 21, 9, 4);

    vi.setSystemTime(new Date(2026, 7, 22, 0, 1));

    expect(formatTimeOfDayOrMonthDay(contribution)).toBe("08/21");
  });
});
