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
      BranchMetricPeriod.SixtyDays,
      "2026-06-04T21:00:00.000Z",
      "2026-04-05T21:00:00.000Z",
      "vs prior 60d",
    ],
    [
      BranchMetricPeriod.NinetyDays,
      "2026-05-05T21:00:00.000Z",
      "2026-02-04T21:00:00.000Z",
      "QoQ",
    ],
  ])(
    "builds adjacent %s UTC windows",
    (period, startAt, priorStartAt, label) => {
      expect(buildAdjacentBranchMetricWindows(period, now)).toEqual({
        period,
        label,
        current: { startAt, endAt: now.toISOString() },
        prior: { startAt: priorStartAt, endAt: startAt },
      });
    }
  );

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

  it("returns N/A for a zero prior", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 1 },
        { state: BranchMetricAvailability.Complete, value: 0 }
      ).deltaPct.state
    ).toBe(BranchMetricAvailability.NotApplicable);
    // `pctDelta`'s base floor is NEAR zero, not exactly zero: a sub-unit prior
    // (a $0.50 spend, a 0.8 LOC/$) declines too. The old producer tested
    // `prior.value === 0` and published a percentage off such a base; adopting
    // the Sessions SSOT widens that floor, and this pins the widening.
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 1 },
        { state: BranchMetricAvailability.Complete, value: 0.5 }
      ).deltaPct.state
    ).toBe(BranchMetricAvailability.NotApplicable);
  });

  /**
   * ISS-10540 — a deliberate behavior change, not a relaxed expectation.
   *
   * This pair previously pinned `Unavailable` for a partial side, which on real
   * data is every non-count Branch metric, so the comparison slot read "No
   * comparison" on every card in every window. A percentage off two
   * incomplete-but-real populations is a real percentage; the shortfall is a
   * disclosure published beside it, so the number now renders and carries the
   * sentence naming what was short (operator ruling, Tamsin, 2026-09-21).
   */
  it("publishes a partial percentage rather than refusing one", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 15 },
        {
          state: BranchMetricAvailability.Partial,
          value: 10,
          coverage: { included: 1, total: 2 },
          disclosure: BranchMetricDisclosure.PrIncomplete,
        }
      ).deltaPct
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 50,
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        {
          state: BranchMetricAvailability.Partial,
          value: 5,
          disclosure: BranchMetricDisclosure.CostIncomplete,
        },
        { state: BranchMetricAvailability.Complete, value: 10 }
      ).deltaPct
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: -50,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });

  it("falls back to the cause-free sentence when the two windows disagree", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        {
          state: BranchMetricAvailability.Partial,
          value: 15,
          disclosure: BranchMetricDisclosure.CostIncomplete,
        },
        {
          state: BranchMetricAvailability.Partial,
          value: 10,
          disclosure: BranchMetricDisclosure.PrIncomplete,
        }
      ).deltaPct
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 50,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
  });

  it("still declines when a side produced no number, naming the absent side", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 1 },
        { state: BranchMetricAvailability.Unavailable, value: null }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
    // EITHER side: an unreadable current over a real prior is the same absence.
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Unavailable, value: null },
        { state: BranchMetricAvailability.Complete, value: 1 }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        {
          state: BranchMetricAvailability.Partial,
          value: 1,
          disclosure: BranchMetricDisclosure.DefaultIncomplete,
        },
        { state: BranchMetricAvailability.NoData, value: null }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.NotApplicable, value: null });
  });

  /**
   * The percentage is `pctDelta`'s, not arithmetic spelled out here, and
   * publishing the comparison is what made that matter: a raw ratio reaches
   * `MetricCard`'s formatter verbatim, so `13` against `9` rendered
   * `+44.44444444444444%` in the chip. WHOLE percents are the contract.
   */
  it("rounds the percentage to a whole percent", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 13 },
        { state: BranchMetricAvailability.Complete, value: 9 }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 44 });
    // Same on the partial path, so the two cannot drift.
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        {
          state: BranchMetricAvailability.Partial,
          value: 13,
          disclosure: BranchMetricDisclosure.PrIncomplete,
        },
        { state: BranchMetricAvailability.Complete, value: 9 }
      ).deltaPct
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 44,
      disclosure: BranchMetricDisclosure.PrIncomplete,
    });
  });

  /**
   * An EXACT 999% is the case that made this more than a rounding fix. The card
   * hands `deltaPct` to `formatDeltaPct`, whose `>999%` label means "an older
   * producer CLAMPED this" — so a precise 999 rendered as a bound this product
   * does not assert. `pctDelta` declines at the ceiling (ISS-5003) rather than
   * returning a figure that cannot be told apart from a clamp, and the decline
   * lands on the state the unusable-prior case already reports.
   */
  it("declines at the display ceiling rather than minting a clamp-shaped figure", () => {
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 1099 },
        { state: BranchMetricAvailability.Complete, value: 100 }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.NotApplicable, value: null });
    // Just under it still publishes, so the case above is the ceiling and not a
    // blanket refusal of large movements.
    expect(
      buildBranchMetricComparison(
        BranchMetricComparisonLabel.WeekOverWeek,
        PRIOR_WINDOW,
        { state: BranchMetricAvailability.Complete, value: 1098 },
        { state: BranchMetricAvailability.Complete, value: 100 }
      ).deltaPct
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 998 });
  });
});

const PRIOR_WINDOW = {
  startAt: "2026-07-20T21:00:00.000Z",
  endAt: "2026-07-27T21:00:00.000Z",
};
