import {
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  ])(
    "resolves adjacent $period windows from an explicit range",
    ({ period, startDate, priorStartAt, label }) => {
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
    }
  );

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

  it("keeps arbitrary explicit ranges as All, and carries the requested bounds for the PR metrics (ISS-11589 D2)", () => {
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
      requested: {
        startAt: "2026-07-01T00:00:00.000Z",
        endAt: NOW.toISOString(),
      },
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

  /**
   * ISS-9619 — a Local-mode preset window is N CALENDAR days, which is not N*24h
   * in a week that changes UTC offset. 2026-03-08 is the US spring-forward, so a
   * Local 7d window over it runs one hour short of seven nominal days.
   *
   * Without the civil-offset arm in `matchesPeriod` this classifies as `All`,
   * whose prior window is `null` — so the Branches summary cards silently drop
   * their week-over-week comparison for the transition week, with nothing on
   * screen saying why. That is the failure this pins.
   */
  it("classifies a Local calendar week spanning a DST transition as SevenDays", () => {
    // Local midnight Mar 2 (EST, UTC-5) to local 23:59:59.999 on Mar 8 (EDT, UTC-4).
    const startDate = "2026-03-02T05:00:00.000Z";
    const endDate = "2026-03-09T03:59:59.999Z";

    const windows = resolveCanonicalBranchMetricWindows({
      startDate,
      endDate,
      now: new Date(endDate),
    });

    expect(windows.period).toBe(BranchMetricPeriod.SevenDays);
    expect(windows.label).toBe(BranchMetricComparisonLabel.WeekOverWeek);
    // The comparison survives, which is the whole point of the classification.
    expect(windows.prior).not.toBeNull();
    // ISS-9619 (whitlockk review): and the current window is the window the ROW LIST
    // was read over — the requested start, not `end - 7*24h`. Classifying the
    // range as SevenDays does not by itself make the metric builder use these
    // bounds: it used to reconstruct the start by backing the end up a fixed 168
    // hours, which on this range lands at 04:00 rather than the requested 05:00,
    // so the summary cards counted roughly an extra hour the table excluded.
    expect(windows.current.startAt).toBe(startDate);
    // And the INCLUSIVE end (local 23:59:59.999) is normalized to the exclusive
    // bound the half-open membership test wants, exactly as the exact-width arm
    // already does — otherwise the final millisecond of the reader's last local
    // day falls outside the metric window while the list includes it.
    expect(windows.current.endAt).toBe("2026-03-09T04:00:00.000Z");
  });

  /**
   * The other half of that widening, and the reason it is quarter-hours rather
   * than a tolerance band: a window that merely LOOKS about a week long is still
   * `All`. `branch-list-metric-projection.test.ts` pins the same 4-minute case
   * from the classifier side; this pins that ISS-9619 did not loosen it.
   */
  it("still refuses a window that is merely close to seven days", () => {
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: "2026-07-27T00:04:00.000Z",
      endDate: NOW,
      now: NOW,
    });

    expect(windows.period).toBe(BranchMetricPeriod.All);
    expect(windows.prior).toBeNull();
  });

  /**
   * ISS-9585 (whitlockk, PR #7954). The Branch list's ROW path anchors its window
   * bounds; this is the METRIC CARD path over the same request, reached by the
   * cloud list and, through `readCanonicalBranchMetricEventRows`, by every
   * desktop. Read with a bare `new Date(value)` the cards described a different
   * span than the rows beneath them, by the reader's own UTC offset.
   *
   * Unconditional restore, so a throw mid-case cannot leak a zone into a later
   * test in this worker.
   */
  describe("window bound anchoring (ISS-9585)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("resolves a zone-less bound to the same window on every host", () => {
      const zoneless = "2026-07-27T00:00:00";
      const unanchored: number[] = [];

      const resolved = ["UTC", "America/Chicago", "Asia/Tokyo"].map((zone) => {
        vi.stubEnv("TZ", zone);
        unanchored.push(Date.parse(zoneless));
        return resolveCanonicalBranchMetricWindows({
          startDate: zoneless,
          endDate: NOW,
          now: NOW,
        });
      });

      // The premise, asserted rather than assumed: the stub really moves the
      // clock, so an unanchored bound WOULD name three instants here and only
      // one of them is exactly seven days wide. Without this the agreement
      // below passes vacuously.
      expect(new Set(unanchored).size).toBe(3);
      expect(resolved.map((windows) => windows.current.startAt)).toEqual([
        "2026-07-27T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
        "2026-07-27T00:00:00.000Z",
      ]);
      expect(resolved.map((windows) => windows.period)).toEqual([
        BranchMetricPeriod.SevenDays,
        BranchMetricPeriod.SevenDays,
        BranchMetricPeriod.SevenDays,
      ]);
    });
  });
});
