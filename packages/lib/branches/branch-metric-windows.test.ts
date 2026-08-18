import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  buildAdjacentBranchMetricWindows,
  buildBranchMetricComparison,
  isTimestampInBranchMetricWindow,
} from "./branch-metric-windows";

describe("Branch metric windows", () => {
  const now = new Date("2026-08-03T21:00:00.000Z");

  it.each([
    [
      BranchMetricPeriod.SevenDays,
      "2026-07-27T21:00:00.000Z",
      "2026-07-20T21:00:00.000Z",
      "WoW",
    ],
    [
      BranchMetricPeriod.ThirtyDays,
      "2026-07-04T21:00:00.000Z",
      "2026-06-04T21:00:00.000Z",
      "MoM",
    ],
    [
      BranchMetricPeriod.NinetyDays,
      "2026-05-05T21:00:00.000Z",
      "2026-02-04T21:00:00.000Z",
      "QoQ",
    ],
  ])("builds adjacent %s UTC windows", (period, startAt, priorStartAt, label) => {
    expect(buildAdjacentBranchMetricWindows(period, now)).toEqual({
      period,
      label,
      current: { startAt, endAt: now.toISOString() },
      prior: { startAt: priorStartAt, endAt: startAt },
    });
  });

  it("uses half-open boundaries with no adjacent overlap", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      now
    );
    if (windows.prior === null) {
      throw new Error("expected prior window");
    }
    expect(
      isTimestampInBranchMetricWindow(windows.current.startAt, windows.current)
    ).toBe(true);
    expect(
      isTimestampInBranchMetricWindow(windows.current.startAt, windows.prior)
    ).toBe(false);
    expect(isTimestampInBranchMetricWindow(now, windows.current)).toBe(false);
  });

  it("keeps all time comparison-free", () => {
    expect(
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, now)
    ).toEqual({
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: now.toISOString() },
      prior: null,
    });
  });

  it("truncates the prior window to the elapsed span of a still-open period", () => {
    // ISS-5809 ends the requested window with the in-progress UTC day, so `end`
    // sits in the future. Only 6d 12h of this 7d period has actually elapsed; a
    // full-width prior window would grade that partial population against a
    // complete one and report the time of day as a WoW movement.
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      new Date("2026-08-04T00:00:00.000Z"),
      new Date("2026-08-03T12:00:00.000Z")
    );

    // The current window is untouched — it must keep matching the row list.
    expect(windows.current).toEqual({
      startAt: "2026-07-28T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z",
    });
    // The prior window opens one FULL period back — same weekday, same hour — and
    // closes after the 6d 12h that has elapsed. Truncating the END rather than
    // sliding the START is what keeps the two slices at the same phase; the other
    // way round would let ordinary weekday shape read as WoW movement.
    expect(windows.prior).toEqual({
      startAt: "2026-07-21T00:00:00.000Z",
      endAt: "2026-07-27T12:00:00.000Z",
    });
  });

  it("leaves the prior window at full width once the period has fully elapsed", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      now,
      new Date("2026-08-04T00:00:00.000Z")
    );

    expect(windows.prior).toEqual({
      startAt: "2026-07-20T21:00:00.000Z",
      endAt: "2026-07-27T21:00:00.000Z",
    });
  });

  it("drops the comparison for a period that has not opened yet", () => {
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      new Date("2026-09-07T00:00:00.000Z"),
      new Date("2026-08-03T12:00:00.000Z")
    );

    expect(windows.prior).toBeNull();
    // ...and an absent prior window is what makes the chip decline rather than
    // render a clock-driven percentage.
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        { startAt: null, endAt: windows.current.endAt },
        { state: BranchMetricAvailability.Complete, value: 10 },
        { state: BranchMetricAvailability.Unavailable, value: null }
      ).deltaPct.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });

  it("computes the exact percentage only from complete nonzero values", () => {
    const result = buildBranchMetricComparison(
      BranchMetricComparisonLabel.WeekOverWeek,
      {
        startAt: "2026-07-20T21:00:00.000Z",
        endAt: "2026-07-27T21:00:00.000Z",
      },
      { state: BranchMetricAvailability.Complete, value: 15 },
      { state: BranchMetricAvailability.Complete, value: 10 }
    );
    expect(result.deltaPct).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 50,
    });
  });

  it("returns N/A for a zero prior and Unavailable for incomplete evidence", () => {
    const window = {
      startAt: "2026-07-20T21:00:00.000Z",
      endAt: "2026-07-27T21:00:00.000Z",
    };
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        window,
        { state: BranchMetricAvailability.Complete, value: 1 },
        { state: BranchMetricAvailability.Complete, value: 0 }
      ).deltaPct.state
    ).toBe(BranchMetricAvailability.NotApplicable);
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        window,
        { state: BranchMetricAvailability.Complete, value: 1 },
        {
          state: BranchMetricAvailability.Partial,
          value: 1,
          coverage: { included: 1, total: 2 },
          disclosure: BranchMetricDisclosure.DefaultIncomplete,
        }
      ).deltaPct.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });
});
