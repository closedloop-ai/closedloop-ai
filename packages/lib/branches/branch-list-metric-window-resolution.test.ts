import {
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import { resolveCanonicalBranchMetricWindows } from "./branch-list-metric-projection";

const NOW = new Date("2026-08-03T00:00:00.000Z");

describe("canonical Branch metric window resolution", () => {
  it.each([
    {
      period: BranchMetricPeriod.SevenDays,
      startDate: "2026-07-27T00:00:00.000Z",
      priorStartAt: "2026-07-20T00:00:00.000Z",
      label: BranchMetricComparisonLabel.WeekOverWeek,
    },
    {
      period: BranchMetricPeriod.ThirtyDays,
      startDate: "2026-07-04T00:00:00.000Z",
      priorStartAt: "2026-06-04T00:00:00.000Z",
      label: BranchMetricComparisonLabel.MonthOverMonth,
    },
    {
      period: BranchMetricPeriod.NinetyDays,
      startDate: "2026-05-05T00:00:00.000Z",
      priorStartAt: "2026-02-04T00:00:00.000Z",
      label: BranchMetricComparisonLabel.QuarterOverQuarter,
    },
  ])("resolves adjacent $period windows from an explicit range", ({
    period,
    startDate,
    priorStartAt,
    label,
  }) => {
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate,
        endDate: NOW,
        now: NOW,
      })
    ).toEqual({
      period,
      label,
      current: {
        startAt: startDate,
        endAt: NOW.toISOString(),
      },
      prior: {
        startAt: priorStartAt,
        endAt: startDate,
      },
    });
  });

  it("pins a start-only range to its exact canonical end", () => {
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-27T00:00:00.000Z",
        now: new Date("2026-08-03T00:00:01.000Z"),
      })
    ).toEqual({
      period: BranchMetricPeriod.SevenDays,
      label: BranchMetricComparisonLabel.WeekOverWeek,
      current: {
        startAt: "2026-07-27T00:00:00.000Z",
        endAt: NOW.toISOString(),
      },
      prior: {
        startAt: "2026-07-20T00:00:00.000Z",
        endAt: "2026-07-27T00:00:00.000Z",
      },
    });
  });

  it("normalizes an inclusive UTC-day end to the canonical half-open boundary", () => {
    // ISS-5809: the requested end is the in-progress UTC day, so the normalized
    // `end` is in the future and only 6d 12h of the period has elapsed at this
    // `now`. The CURRENT window keeps the full canonical span — it must stay the
    // same population the row list shows — while the prior window opens one full
    // period earlier and closes after that elapsed span, so the comparison is
    // both equal-length and equal-phase rather than a partial period graded
    // against a complete one.
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-28T00:00:00.000Z",
        endDate: "2026-08-03T23:59:59.999Z",
        now: new Date("2026-08-03T12:00:00.000Z"),
      })
    ).toEqual({
      period: BranchMetricPeriod.SevenDays,
      label: BranchMetricComparisonLabel.WeekOverWeek,
      current: {
        startAt: "2026-07-28T00:00:00.000Z",
        endAt: "2026-08-04T00:00:00.000Z",
      },
      prior: {
        startAt: "2026-07-21T00:00:00.000Z",
        endAt: "2026-07-27T12:00:00.000Z",
      },
    });
  });

  it("restores the full-width prior window once the requested day has closed", () => {
    // The same request one UTC day later: nothing is in progress any more, so the
    // truncation is a no-op and the two periods are both a complete 7 days.
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-28T00:00:00.000Z",
        endDate: "2026-08-03T23:59:59.999Z",
        now: new Date("2026-08-04T00:00:00.000Z"),
      }).prior
    ).toEqual({
      startAt: "2026-07-21T00:00:00.000Z",
      endAt: "2026-07-28T00:00:00.000Z",
    });
  });

  it("preserves arbitrary explicit ranges as All ending at the requested boundary", () => {
    expect(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-01T00:00:00.000Z",
        endDate: NOW,
        now: new Date("2026-08-10T00:00:00.000Z"),
      })
    ).toEqual({
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: NOW.toISOString() },
      prior: null,
    });
  });

  it("preserves an unbounded All range at the pinned request boundary", () => {
    expect(resolveCanonicalBranchMetricWindows({ now: NOW })).toEqual({
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: NOW.toISOString() },
      prior: null,
    });
  });
});
