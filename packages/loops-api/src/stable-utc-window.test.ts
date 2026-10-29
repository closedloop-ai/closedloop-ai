import { describe, expect, it } from "vitest";
import {
  stableUtcDayEnd,
  stableUtcDayStart,
  stableUtcDayWindow,
  stableUtcListWindow,
  stableUtcPriorWindow,
  stableUtcWindowElapsedEnd,
} from "./stable-utc-window";

/**
 * ISS-10583 — the one producer every window on both shells is resolved from, so
 * its edges are pinned here rather than only through its three consumers.
 *
 * Every expectation is a hand-written instant obtained by counting UTC days.
 */
describe("stableUtcDayStart", () => {
  it("floors to the UTC midnight opening the offset day", () => {
    const now = new Date("2026-09-17T12:34:56.789Z");
    expect(stableUtcDayStart(now).toISOString()).toBe(
      "2026-09-17T00:00:00.000Z"
    );
    expect(stableUtcDayStart(now, -6).toISOString()).toBe(
      "2026-09-11T00:00:00.000Z"
    );
  });

  it("carries across a month boundary", () => {
    // Sep 3 back 6 days lands in August, which only normalizes correctly
    // because the day component is allowed to go negative.
    expect(
      stableUtcDayStart(new Date("2026-09-03T08:00:00.000Z"), -6).toISOString()
    ).toBe("2026-08-28T00:00:00.000Z");
  });

  it("carries across a year boundary and a non-leap February", () => {
    // Mar 1 2026 back 90 days: Feb has 28 days in 2026, Jan 31, Dec 31.
    expect(
      stableUtcDayStart(new Date("2026-03-01T23:00:00.000Z"), -89).toISOString()
    ).toBe("2025-12-02T00:00:00.000Z");
  });

  it("is unaffected by a civil DST transition", () => {
    // Europe/London moved its clocks on 2026-03-29; UTC did not, so the window
    // opening 7 days earlier is exactly 7 * 24h back and not 7 * 24h - 1h.
    const before = stableUtcDayStart(new Date("2026-03-29T12:00:00.000Z"), -6);
    expect(before.toISOString()).toBe("2026-03-23T00:00:00.000Z");
  });
});

describe("stableUtcDayEnd", () => {
  it("is the last representable instant of the UTC day", () => {
    expect(
      stableUtcDayEnd(new Date("2026-09-17T00:00:00.000Z")).toISOString()
    ).toBe("2026-09-17T23:59:59.999Z");
  });
});

describe("stableUtcDayWindow", () => {
  it("is the inclusive run of N UTC days ending with today", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect({
      start: stableUtcDayWindow(7, now).start.toISOString(),
      end: stableUtcDayWindow(7, now).end.toISOString(),
    }).toEqual({
      start: "2026-09-11T00:00:00.000Z",
      end: "2026-09-17T23:59:59.999Z",
    });
  });

  it("spans exactly N days, to the millisecond", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    for (const days of [7, 30, 90]) {
      const { start, end } = stableUtcDayWindow(days, now);
      expect(end.getTime() - start.getTime() + 1).toBe(days * 86_400_000);
    }
  });

  it("does not move through the UTC day but does move across it", () => {
    const open = stableUtcDayWindow(7, new Date("2026-09-17T00:00:00.000Z"));
    const close = stableUtcDayWindow(7, new Date("2026-09-17T23:59:59.999Z"));
    expect(open).toEqual(close);
    const next = stableUtcDayWindow(7, new Date("2026-09-18T00:00:00.000Z"));
    expect(next.start.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("stableUtcWindowElapsedEnd", () => {
  const end = new Date("2026-09-17T23:59:59.999Z");

  it("is the clock while the day is still running", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect(stableUtcWindowElapsedEnd(end, now).toISOString()).toBe(
      "2026-09-17T12:00:00.000Z"
    );
  });

  it("stops at the window end once the clock reaches it", () => {
    // The arm the consumers never take, because they derive `end` from the same
    // `now` — it exists so a caller that does not cannot run the axis past the
    // window.
    const past = new Date("2026-09-18T06:00:00.000Z");
    expect(stableUtcWindowElapsedEnd(end, past).toISOString()).toBe(
      "2026-09-17T23:59:59.999Z"
    );
  });

  it("returns a copy the caller cannot use to mutate the clock", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const elapsed = stableUtcWindowElapsedEnd(end, now);
    expect(elapsed).not.toBe(now);
    elapsed.setUTCFullYear(1999);
    expect(now.toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });
});

describe("stableUtcPriorWindow", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const { start, end } = stableUtcDayWindow(7, now);

  it("opens one full period back and closes after the elapsed span", () => {
    const prior = stableUtcPriorWindow(start, end, now);
    expect(prior?.start.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(prior?.end.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("covers the same elapsed span as the current window, at the same phase", () => {
    const prior = requirePriorWindow();
    expect(prior.end.getTime() - prior.start.getTime()).toBe(
      now.getTime() - start.getTime()
    );
    // Same weekday and same hour — the property that keeps ordinary diurnal
    // shape out of the percentage.
    expect(prior.start.getUTCDay()).toBe(start.getUTCDay());
    expect(prior.start.getUTCHours()).toBe(start.getUTCHours());
  });

  it("closes strictly before the current window opens, so no row is in both", () => {
    expect(requirePriorWindow().end.getTime()).toBeLessThan(start.getTime());
  });

  /** Throws rather than narrowing with a cast, so a null here fails loudly. */
  function requirePriorWindow(): { start: Date; end: Date } {
    const prior = stableUtcPriorWindow(start, end, now);
    if (prior === null) {
      throw new Error("expected a prior window for a 7-day range at midday");
    }
    return prior;
  }

  it("declines when nothing has elapsed", () => {
    expect(stableUtcPriorWindow(start, end, start)).toBeNull();
  });
});

describe("stableUtcListWindow", () => {
  const now = new Date("2026-03-10T15:30:00.000Z");

  it("serializes the N-day window as ISO list bounds", () => {
    expect(stableUtcListWindow(7, now)).toEqual({
      startDate: "2026-03-04T00:00:00.000Z",
      endDate: "2026-03-10T23:59:59.999Z",
    });
  });

  it("applies no bound for all time", () => {
    expect(stableUtcListWindow(null, now)).toStrictEqual({});
  });
});
