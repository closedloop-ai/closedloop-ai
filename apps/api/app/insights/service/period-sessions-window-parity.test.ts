import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import {
  PARITY_ELAPSED_END_ISO,
  PARITY_FUTURE_LAST_ACTIVITY_ISO,
  PARITY_NEXT_UTC_DAY_NOW_ISO,
  PARITY_NEXT_UTC_DAY_WINDOW,
  PARITY_NOW_ISO,
  PARITY_PRIOR_WINDOW,
  PARITY_WINDOW_BY_DAYS,
  PARITY_WINDOW_DAYS,
} from "@closedloop-ai/loops-api/test-fixtures/stable-utc-window-parity";
import { describe, expect, it } from "vitest";
import { resolvePeriodRange } from "./period";

/**
 * ISS-10583 — the cloud half of the cross-surface window parity pair. Its
 * desktop twin is `apps/desktop/test/insights-sessions-window-parity.test.ts`,
 * and both assert the SAME shared table, which is why a change to one resolver
 * cannot be made green by editing the expectation sitting beside it.
 *
 * The two resolvers cannot be imported into one suite — `apps/api` does not
 * depend on `@repo/app` — so that fixture is what holds them together.
 */
const NOW = new Date(PARITY_NOW_ISO);

const PERIOD_BY_DAYS: Record<number, InsightsPeriod> = {
  7: InsightsPeriod.Week,
  30: InsightsPeriod.Month,
  90: InsightsPeriod.Quarter,
};

describe("insights and Sessions resolve one window (ISS-10583)", () => {
  it.each(PARITY_WINDOW_DAYS)(
    "the cloud insights window for %s days is the shared written-out window",
    (days) => {
      const range = resolvePeriodRange(PERIOD_BY_DAYS[days], NOW);
      expect({
        startDate: range.start.toISOString(),
        endDate: range.end.toISOString(),
      }).toEqual(PARITY_WINDOW_BY_DAYS[days]);
    }
  );

  it("the all-time window opens at the epoch and closes with the same UTC day", () => {
    const range = resolvePeriodRange(InsightsPeriod.All, NOW);
    expect(range.start.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    // The same closing instant every bounded window uses, so "all time" and
    // "Last 7 days" agree about where today ends.
    expect(range.end.toISOString()).toBe(PARITY_WINDOW_BY_DAYS[7].endDate);
  });

  it.each(PARITY_WINDOW_DAYS)(
    "the Sessions-list window for %s days is the same shared window",
    (days) => {
      const { sessionsWindow } = resolvePeriodRange(PERIOD_BY_DAYS[days], NOW);
      expect({
        startDate: sessionsWindow.start?.toISOString(),
        endDate: sessionsWindow.end?.toISOString(),
      }).toEqual(PARITY_WINDOW_BY_DAYS[days]);
    }
  );

  it("the all-time Sessions-list window admits a session last active after today ends (ISS-12263)", () => {
    const range = resolvePeriodRange(InsightsPeriod.All, NOW);
    const future = new Date(PARITY_FUTURE_LAST_ACTIVITY_ISO);
    // The fixture really is past the bound the started-at reads keep, so the
    // admission below is not a session `end` already covered.
    expect(future.getTime()).toBeGreaterThan(range.end.getTime());
    // The Sessions list sends no bounds for "All", so neither may the Sessions
    // KPI, its status donut, or the cost.
    expect(range.sessionsWindow).toEqual({});
  });

  it("the window has only elapsed as far as the real clock", () => {
    // `end` is ahead of `now` by design — a stable bound cannot also be the
    // clock. Every daily-bucketed series and the prior window read `elapsedEnd`
    // instead, so a reader east of UTC gets no trailing empty chart column and
    // no clock-driven delta.
    const range = resolvePeriodRange(InsightsPeriod.Week, NOW);
    expect(range.elapsedEnd.toISOString()).toBe(PARITY_ELAPSED_END_ISO);
    expect(range.end.toISOString()).toBe(PARITY_WINDOW_BY_DAYS[7].endDate);
  });

  it("the prior window opens one full period back and closes after the elapsed span", () => {
    const range = resolvePeriodRange(InsightsPeriod.Week, NOW);
    expect({
      startDate: range.priorStart?.toISOString(),
      endDate: range.priorEnd.toISOString(),
    }).toEqual(PARITY_PRIOR_WINDOW);
  });

  it("at exactly UTC midnight the prior window is the narrowest the product shows", () => {
    // The case the truncation exists for: the current window has elapsed only
    // its whole days, so a FULL-width prior window would grade a period that has
    // barely opened against a complete one and report the clock as a trend.
    const range = resolvePeriodRange(
      InsightsPeriod.Week,
      new Date("2026-09-17T00:00:00.000Z")
    );
    expect(range.elapsedEnd.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(range.priorStart?.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(range.priorEnd.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("the window does not move through the UTC day", () => {
    const justAfterMidnight = resolvePeriodRange(
      InsightsPeriod.Week,
      new Date("2026-09-17T00:00:00.001Z")
    );
    const justBeforeMidnight = resolvePeriodRange(
      InsightsPeriod.Week,
      new Date("2026-09-17T23:59:59.998Z")
    );
    expect(justAfterMidnight.start).toEqual(justBeforeMidnight.start);
    expect(justAfterMidnight.end).toEqual(justBeforeMidnight.end);
    // The positive twin of that equality: crossing INTO the next UTC day does
    // move it, so the assertion above is pinning stability rather than a bound
    // that ignores `now` altogether.
    const nextUtcDay = resolvePeriodRange(
      InsightsPeriod.Week,
      new Date(PARITY_NEXT_UTC_DAY_NOW_ISO)
    );
    expect({
      startDate: nextUtcDay.start.toISOString(),
      endDate: nextUtcDay.end.toISOString(),
    }).toEqual(PARITY_NEXT_UTC_DAY_WINDOW);
  });
});
