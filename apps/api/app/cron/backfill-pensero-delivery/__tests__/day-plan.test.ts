/**
 * ISS-8761: the day planner behind the scheduled Pensero delivery backfill.
 *
 * Every expectation here is a LITERAL day written independently of the
 * implementation — the dates are counted by hand from the stated "today", not
 * re-derived with the same arithmetic the planner uses. A test that computes
 * its expectation the way the code does cannot fail when that arithmetic is
 * wrong, which is the whole class of day-boundary bug this file exists for.
 */

import { describe, expect, it } from "vitest";
import {
  advanceBackwardCursor,
  advanceRecheckCursor,
  BackfillDayReason,
  planBackfillDays,
} from "../day-plan";

const TODAY = new Date("2026-09-02T13:45:00.000Z");

function daysOf(plan: { days: readonly { day: string }[] }): string[] {
  return plan.days.map((entry) => entry.day);
}

describe("planBackfillDays", () => {
  it("always asks for today first, on a run that has never run before", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: null, recheckCursor: null },
      attemptedDays: [],
      maxDays: 4,
      backwardDaysPerRun: 3,
    });

    expect(plan.days[0]).toEqual({
      day: "2026-09-02",
      reason: BackfillDayReason.Today,
    });
    // Backward starts at YESTERDAY: today is served by its own lane, and the
    // walk anchors on today only because nothing has been attempted yet.
    expect(daysOf(plan)).toEqual([
      "2026-09-02",
      "2026-09-01",
      "2026-08-31",
      "2026-08-30",
    ]);
  });

  it("resumes the backward walk strictly below the stored cursor", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2026-08-20", recheckCursor: null },
      attemptedDays: [],
      maxDays: 3,
      backwardDaysPerRun: 2,
    });

    expect(daysOf(plan)).toEqual(["2026-09-02", "2026-08-19", "2026-08-18"]);
  });

  it("crosses a month boundary without inventing a 31st of September", () => {
    const plan = planBackfillDays({
      today: new Date("2026-09-01T00:30:00.000Z"),
      cursors: { backwardCursor: "2026-09-01", recheckCursor: null },
      attemptedDays: [],
      maxDays: 3,
      backwardDaysPerRun: 2,
    });

    expect(daysOf(plan)).toEqual(["2026-09-01", "2026-08-31", "2026-08-30"]);
  });

  it("crosses a leap day rather than skipping it", () => {
    const plan = planBackfillDays({
      today: new Date("2028-03-01T00:00:00.000Z"),
      cursors: { backwardCursor: "2028-03-01", recheckCursor: null },
      attemptedDays: [],
      maxDays: 3,
      backwardDaysPerRun: 2,
    });

    expect(daysOf(plan)).toEqual(["2028-03-01", "2028-02-29", "2028-02-28"]);
  });

  it("spends leftover budget rechecking previously attempted days", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2026-08-30", recheckCursor: null },
      attemptedDays: ["2026-08-30", "2026-08-31", "2026-09-01"],
      maxDays: 4,
      backwardDaysPerRun: 1,
    });

    expect(plan.days).toEqual([
      { day: "2026-09-02", reason: BackfillDayReason.Today },
      { day: "2026-08-29", reason: BackfillDayReason.Backward },
      { day: "2026-08-30", reason: BackfillDayReason.Recheck },
      { day: "2026-08-31", reason: BackfillDayReason.Recheck },
    ]);
  });

  it("wraps the recheck cursor to the oldest attempted day at the end", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2026-08-30", recheckCursor: "2026-09-01" },
      attemptedDays: ["2026-08-30", "2026-08-31", "2026-09-01"],
      maxDays: 3,
      backwardDaysPerRun: 1,
    });

    // The cursor sits on the newest attempted day, so the next recheck is the
    // OLDEST — not "nothing left to do", which would freeze the round robin.
    expect(daysOf(plan)).toEqual(["2026-09-02", "2026-08-29", "2026-08-30"]);
  });

  it("never plans the same day twice in one run", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2026-09-02", recheckCursor: null },
      // Today is in the attempted set, so the recheck lane could otherwise
      // re-pick the day the today lane already claimed.
      attemptedDays: ["2026-09-01", "2026-09-02"],
      maxDays: 4,
      backwardDaysPerRun: 1,
    });

    expect(daysOf(plan)).toEqual(["2026-09-02", "2026-09-01"]);
    expect(new Set(daysOf(plan)).size).toBe(daysOf(plan).length);
  });

  it("reports continuation when the budget is spent, and never drops the remainder", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2026-08-30", recheckCursor: null },
      attemptedDays: ["2026-08-30", "2026-08-31"],
      maxDays: 2,
      backwardDaysPerRun: 5,
    });

    expect(daysOf(plan)).toEqual(["2026-09-02", "2026-08-29"]);
    expect(plan.continuationPending).toBe(true);
  });

  it("clamps a negative or non-finite budget instead of planning nothing", () => {
    // `Math.min` alone would let these through, and an empty plan reads exactly
    // like a completed run — the failure mode `requireDayCount` exists for in
    // the sibling segment planner.
    const negative = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: null, recheckCursor: null },
      attemptedDays: [],
      maxDays: -5,
      backwardDaysPerRun: -1,
    });
    expect(daysOf(negative)).toEqual(["2026-09-02"]);

    const nonFinite = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: null, recheckCursor: null },
      attemptedDays: [],
      maxDays: Number.NaN,
      backwardDaysPerRun: Number.NaN,
    });
    expect(nonFinite.days.length).toBe(8);
    expect(daysOf(nonFinite).at(-1)).toBe("2026-08-26");
  });

  it("applies no historical cutoff — a decade-old cursor still walks backwards", () => {
    const plan = planBackfillDays({
      today: TODAY,
      cursors: { backwardCursor: "2016-01-02", recheckCursor: null },
      attemptedDays: [],
      maxDays: 3,
      backwardDaysPerRun: 2,
    });

    expect(daysOf(plan)).toEqual(["2026-09-02", "2016-01-01", "2015-12-31"]);
  });
});

/**
 * These cases changed shape in #6492 because the CONTRACT was wrong, not
 * because they were inconvenient.
 *
 * The previous signature took an undifferentiated list of every day that
 * succeeded and returned its minimum, and the case named "does NOT advance past
 * a day that failed" never contained a failed BACKWARD day at all — it passed
 * an all-success list with the backward days simply absent, which the minimum
 * also satisfies. It could not fail on the defect it was named for. The cases
 * below pass the backward lane's attempts in walk order, with a failure IN the
 * list, which is the only shape that can distinguish the two behaviours.
 */
describe("advanceBackwardCursor", () => {
  it("advances over a contiguous run of successes", () => {
    expect(
      advanceBackwardCursor("2026-08-30", [
        { day: "2026-08-29", succeeded: true },
        { day: "2026-08-28", succeeded: true },
      ])
    ).toBe("2026-08-28");
  });

  it("STOPS at the first failed backward day, even when an older one succeeded", () => {
    // The shipped defect (codex + whitlockk, #6492): Aug 29 fails, Aug 28 succeeds.
    // Taking the minimum moves the cursor to Aug 28 and the backward lane — which
    // only ever plans days strictly older than the cursor — never asks Aug 29
    // again. A permanent hole in the ledger wearing a green tick.
    expect(
      advanceBackwardCursor("2026-08-30", [
        { day: "2026-08-29", succeeded: false },
        { day: "2026-08-28", succeeded: true },
      ])
    ).toBe("2026-08-30");
  });

  it("does not advance when the run's first backward day failed", () => {
    expect(
      advanceBackwardCursor("2026-08-30", [
        { day: "2026-08-29", succeeded: false },
      ])
    ).toBe("2026-08-30");
  });

  it("stays put when the backward lane attempted nothing", () => {
    // Today and recheck successes reach this function no longer — but even an
    // empty lane must leave the cursor exactly where it was.
    expect(advanceBackwardCursor("2026-08-30", [])).toBe("2026-08-30");
  });

  it("seeds from the first successful backward walk", () => {
    expect(
      advanceBackwardCursor(null, [
        { day: "2026-09-01", succeeded: true },
        { day: "2026-08-31", succeeded: true },
      ])
    ).toBe("2026-08-31");
  });

  it("never moves the cursor NEWER than it already is", () => {
    expect(
      advanceBackwardCursor("2026-08-20", [
        { day: "2026-08-29", succeeded: true },
      ])
    ).toBe("2026-08-20");
  });
});

describe("advanceRecheckCursor", () => {
  it("moves to the last day visited, in walk order", () => {
    expect(
      advanceRecheckCursor("2026-08-29", ["2026-08-30", "2026-08-31"])
    ).toBe("2026-08-31");
  });

  it("uses the last day WALKED, not the largest, when the lane wrapped", () => {
    // The shipped defect (whitlockk, #6492). The lane started at Aug 4, ran off the
    // end and wrapped to Aug 1, Aug 2. The largest of those is the day it
    // STARTED on, so storing it makes the next run wrap again and re-ask Aug 1
    // and Aug 2 immediately while Aug 3 keeps waiting — the round robin repeats
    // a prefix instead of advancing.
    expect(
      advanceRecheckCursor("2026-08-03", [
        "2026-08-04",
        "2026-08-01",
        "2026-08-02",
      ])
    ).toBe("2026-08-02");
  });

  it("stays put when the run rechecked nothing", () => {
    expect(advanceRecheckCursor("2026-08-29", [])).toBe("2026-08-29");
  });
});
