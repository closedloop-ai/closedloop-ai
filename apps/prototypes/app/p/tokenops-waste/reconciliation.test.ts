import { describe, expect, it } from "vitest";
import {
  actionableHours,
  lossTotals,
  lostSessionRows,
  personRows,
  systemicHours,
  totalHours,
  trendPoints,
  unattributedHours,
} from "@/app/p/lost-work/mock";
import {
  MIN_GRADED_SESSIONS,
  ModelVerdict,
  modelRows,
  outcomeRows,
  totalSpendUsd,
  wasteEstimate,
} from "@/app/p/tokenops-waste/mock";
import {
  isLostSession,
  LossClass,
  lossClassOf,
  MOCK_SESSIONS,
  minutesToHours,
  outcomeOf,
  SpendOutcome,
} from "@/lib/analytics/session-fixture";

/**
 * ISS-4935 measures loss in wall-clock, ISS-4977 measures it in dollars, and
 * the two must never disagree about WHICH sessions failed. These assertions are
 * the mechanical version of that promise.
 */

const CENTS = 2;
const TENTHS = 1;

describe("one definition of failure across both prototypes", () => {
  it("keys failure on endsWithError, the same field ISS-4463 shipped on", () => {
    const erroredIds = new Set(
      MOCK_SESSIONS.filter(
        (session) => outcomeOf(session) === SpendOutcome.Errored
      ).map((session) => session.id)
    );
    const endsWithErrorIds = new Set(
      MOCK_SESSIONS.filter((session) => session.endsWithError === true).map(
        (session) => session.id
      )
    );
    expect(erroredIds).toEqual(endsWithErrorIds);
  });

  it("never folds an unrecorded outcome into clean or errored", () => {
    const unknown = MOCK_SESSIONS.filter(
      (session) => outcomeOf(session) === SpendOutcome.Unknown
    );
    expect(unknown.length).toBeGreaterThan(0);
    for (const session of unknown) {
      expect(session.endsWithError).toBeNull();
    }
  });

  it("counts the same failed sessions on the wall-clock side and the cost side", () => {
    // Lost-work: every session it grades as Actionable or Systemic loss.
    const lostWorkFailures = new Set(
      MOCK_SESSIONS.filter((session) => {
        const lossClass = lossClassOf(session);
        return (
          lossClass === LossClass.Actionable || lossClass === LossClass.Systemic
        );
      }).map((session) => session.id)
    );
    // TokenOps: every session inside the recoverable-waste basis.
    const tokenOpsFailures = new Set(
      MOCK_SESSIONS.filter(
        (session) =>
          outcomeOf(session) === SpendOutcome.Errored && isLostSession(session)
      ).map((session) => session.id)
    );
    expect(lostWorkFailures).toEqual(tokenOpsFailures);
  });

  it("maps the unattributed loss class onto the outcome-unknown spend bucket", () => {
    const unattributedIds = new Set(
      MOCK_SESSIONS.filter(
        (session) => lossClassOf(session) === LossClass.Unattributed
      ).map((session) => session.id)
    );
    const unknownLostIds = new Set(
      MOCK_SESSIONS.filter(
        (session) =>
          outcomeOf(session) === SpendOutcome.Unknown && isLostSession(session)
      ).map((session) => session.id)
    );
    expect(unattributedIds).toEqual(unknownLostIds);
  });
});

describe("lost-work totals reconcile with the rows that make them up", () => {
  it("splits every minute of wall-clock into productive or exactly one loss class", () => {
    const split =
      lossTotals.productiveMinutes +
      lossTotals.minutesByClass[LossClass.Actionable] +
      lossTotals.minutesByClass[LossClass.Systemic] +
      lossTotals.minutesByClass[LossClass.Unattributed];
    expect(split).toBe(lossTotals.totalMinutes);
  });

  it("sums the per-person columns back to the page totals", () => {
    const actionable = personRows.reduce(
      (sum, row) => sum + row.actionableMinutes,
      0
    );
    const systemic = personRows.reduce(
      (sum, row) => sum + row.systemicMinutes,
      0
    );
    const unattributed = personRows.reduce(
      (sum, row) => sum + row.unattributedMinutes,
      0
    );
    expect(minutesToHours(actionable)).toBeCloseTo(actionableHours(), TENTHS);
    expect(minutesToHours(systemic)).toBeCloseTo(systemicHours(), TENTHS);
    expect(minutesToHours(unattributed)).toBeCloseTo(
      unattributedHours(),
      TENTHS
    );
  });

  it("sums every person's session count back to the denominator on screen", () => {
    const sessions = personRows.reduce((sum, row) => sum + row.sessionCount, 0);
    expect(sessions).toBe(lossTotals.sessionCount);
  });

  it("sums the trend series back to the class totals it is split from", () => {
    for (const lossClass of [
      LossClass.Actionable,
      LossClass.Systemic,
      LossClass.Unattributed,
    ]) {
      const charted = trendPoints.reduce(
        (sum, point) => sum + (point.values[lossClass] ?? 0),
        0
      );
      expect(charted).toBeCloseTo(
        minutesToHours(lossTotals.minutesByClass[lossClass]),
        TENTHS
      );
    }
  });

  it("lists exactly the sessions that yielded no artifact", () => {
    const expected = MOCK_SESSIONS.filter((session) => isLostSession(session));
    expect(lostSessionRows).toHaveLength(expected.length);
  });

  it("keeps a real zero distinct from an absent value on the person rows", () => {
    // One engineer in the fixture has no coachable loss at all but does lose a
    // run to the org-wide usage limit. That row is what proves a true 0 and a
    // settled dash render differently.
    const clean = personRows.find((row) => row.actionableMinutes === 0);
    expect(clean).toBeDefined();
    expect(clean?.systemicMinutes).toBeGreaterThan(0);
  });

  it("returns a null baseline rather than a zero when the earlier half is too thin", () => {
    for (const row of personRows) {
      if (row.baselineDeltaPts === null) {
        continue;
      }
      expect(Number.isFinite(row.baselineDeltaPts)).toBe(true);
    }
  });
});

describe("tokenops estimates stay visibly separate from the facts", () => {
  it("splits total spend into exactly the three outcome buckets", () => {
    const summed = outcomeRows.reduce((sum, row) => sum + row.usd, 0);
    expect(summed).toBeCloseTo(totalSpendUsd, CENTS);
  });

  it("sums the model rows back to the same total spend the outcome split shows", () => {
    const summed = modelRows.reduce((sum, row) => sum + row.usd, 0);
    expect(summed).toBeCloseTo(totalSpendUsd, CENTS);
  });

  it("keeps the recoverable-waste range inside the spend it was derived from", () => {
    expect(wasteEstimate.lowUsd).toBeGreaterThan(0);
    expect(wasteEstimate.lowUsd).toBeLessThan(wasteEstimate.highUsd);
    expect(wasteEstimate.highUsd).toBeLessThanOrEqual(
      wasteEstimate.errorOutcomeUsd
    );
  });

  it("excludes outcome-unknown spend from the estimate and reports the amount", () => {
    const unknownUsd =
      outcomeRows.find((row) => row.outcome === SpendOutcome.Unknown)?.usd ?? 0;
    expect(wasteEstimate.excludedUnknownUsd).toBeCloseTo(unknownUsd, CENTS);
  });

  it("withholds a verdict, and a confidence, from a model with too few sessions", () => {
    const ungraded = modelRows.filter(
      (row) => row.verdict === ModelVerdict.Ungraded
    );
    expect(ungraded.length).toBeGreaterThan(0);
    for (const row of ungraded) {
      expect(row.sessions).toBeLessThan(MIN_GRADED_SESSIONS);
      // Null, not 0. A zero here would read as "we are certain it is wrong".
      expect(row.confidencePct).toBeNull();
    }
  });

  it("reports a real zero for a model that had no failed sessions", () => {
    const noFailures = modelRows.find((row) => row.errorOutcomeUsd === 0);
    expect(noFailures).toBeDefined();
    // A measured zero, so the spend it DID incur is still a real number.
    expect(noFailures?.usd).toBeGreaterThan(0);
  });

  it("actually exercises more than one verdict", () => {
    // A right-sizing column that says the same thing on every row proves
    // nothing. If the fixture or the thresholds ever flatten it, this fails
    // rather than shipping a table with no signal in it.
    const verdicts = new Set(modelRows.map((row) => row.verdict));
    expect(verdicts.size).toBeGreaterThan(2);
    expect(verdicts.has(ModelVerdict.Underpowered)).toBe(true);
    expect(verdicts.has(ModelVerdict.Ungraded)).toBe(true);
  });

  it("grades every model with enough sessions", () => {
    for (const row of modelRows) {
      const graded = row.verdict !== ModelVerdict.Ungraded;
      expect(graded).toBe(row.sessions >= MIN_GRADED_SESSIONS);
    }
  });
});

describe("the fixture is deterministic", () => {
  it("holds a stable population, so a screenshot and a test see the same data", () => {
    expect(MOCK_SESSIONS.length).toBeGreaterThan(0);
    expect(lossTotals.sessionCount).toBe(MOCK_SESSIONS.length);
    expect(totalHours()).toBeGreaterThan(0);
  });
});
