/**
 * ISS-7705 — the LOC/$ coverage gate.
 *
 * Every case here drives {@link foldLocPerDollarCoverage} and asserts the
 * VERDICT, because the verdict is what suppresses an inflated ratio. The
 * populations are synthetic and written out longhand rather than derived from
 * the module's own constants: a fixture that reads its expectation from the
 * thing it polices cannot fail when that thing changes.
 */
import { describe, expect, it } from "vitest";
import {
  foldLocPerDollarCoverage,
  type LocPerDollarCoverageBasis,
  type LocPerDollarCoverageCounts,
} from "./loc-per-dollar-coverage";

/**
 * The literal state names, spelled independently of
 * `LocPerDollarCoverageState`. Importing that const object here would make the
 * counterfactual that renames or deletes a member pass silently — the assertion
 * would follow the implementation instead of pinning it. The duplication IS the
 * test.
 */
const COMPLETE = "complete";
const MISSING = "missing";
const STALE = "stale";
const MIGRATION_PENDING = "migration_pending";
const COST_BASIS_EXCLUDED = "cost_basis_excluded";
const FAILED = "failed";

/** A cohort whose denominator covers its numerator exactly. */
function coveredCounts(
  overrides: Partial<LocPerDollarCoverageCounts> = {}
): LocPerDollarCoverageCounts {
  return {
    numeratorSessionCount: 4,
    coveredNumeratorSessionCount: 4,
    migrationPendingSessionCount: 0,
    unrevisionedSessionCount: 0,
    ...overrides,
  };
}

/** A basis with nothing left out of the divisor's ledger. */
function wholeBasis(
  overrides: Partial<LocPerDollarCoverageBasis> = {}
): LocPerDollarCoverageBasis {
  return {
    denominatorSessionCount: 12,
    costBasisCoveredUsd: 40,
    costBasisExcludedUsd: 0,
    ...overrides,
  };
}

describe("foldLocPerDollarCoverage — the fail-closed verdict", () => {
  it("reports complete when the denominator covers the numerator and omits no spend", () => {
    const coverage = foldLocPerDollarCoverage(coveredCounts(), wholeBasis());

    expect(coverage.state).toBe(COMPLETE);
    expect(coverage.excludedSessionCount).toBe(0);
  });

  /**
   * AC4 — THE FAILURE FIXTURE. Merged PR/LOC evidence survives while a
   * qualifying session's cost row does not reach the divisor. A fixture with
   * complete coverage proves nothing, so this one is deliberately lopsided:
   * four sessions carry the merged-PR links the lines were read through, and the
   * divisor sums only three of them.
   */
  it("reports missing when numerator-bearing sessions are absent from the denominator (AC4)", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 4,
        coveredNumeratorSessionCount: 3,
      }),
      wholeBasis()
    );

    expect(coverage.state).toBe(MISSING);
    // The size of the hole is what makes the signal actionable: one session's
    // lines are being divided by nobody's dollars.
    expect(coverage.excludedSessionCount).toBe(1);
    expect(coverage.numeratorSessionCount).toBe(4);
  });

  it("reports migration_pending while a chunked replacement is staged and uncommitted", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({ migrationPendingSessionCount: 1 }),
      wholeBasis()
    );

    expect(coverage.state).toBe(MIGRATION_PENDING);
  });

  it("reports stale when a numerator session's cost was never revision-stamped", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({ unrevisionedSessionCount: 2 }),
      wholeBasis()
    );

    expect(coverage.state).toBe(STALE);
  });

  it("reports cost_basis_excluded when the divisor's ledger omits this cohort's spend (ISS-6526)", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts(),
      wholeBasis({ costBasisCoveredUsd: 10, costBasisExcludedUsd: 90 })
    );

    expect(coverage.state).toBe(COST_BASIS_EXCLUDED);
    expect(coverage.costBasisExcludedUsd).toBe(90);
    expect(coverage.costBasisCoveredUsd).toBe(10);
  });

  /**
   * AC5 — THE ROLLOUT GATE. A data-revision bump cannot change the published
   * ratio until the replacement cohort is complete and validated.
   *
   * The bump is what stages `pendingChunkRevision` on the affected sessions
   * (`chunk-revision-gating.ts` — chunk 0 of an advancing revision), and no
   * cloud read path gates on that column, so mid-flight the divisor sums a
   * cohort the producer is actively replacing. This asserts BOTH ends of the
   * rollout: staged suppresses, and committing (the marker cleared) restores.
   */
  it("suppresses the ratio for the whole staged window of a revision bump, and only then restores it (AC5)", () => {
    const beforeBump = foldLocPerDollarCoverage(coveredCounts(), wholeBasis());
    expect(beforeBump.state).toBe(COMPLETE);

    // Chunk 0 of the advancing revision lands: the marker is staged on one of
    // the numerator-bearing sessions.
    const midBump = foldLocPerDollarCoverage(
      coveredCounts({ migrationPendingSessionCount: 1 }),
      wholeBasis()
    );
    expect(midBump.state).toBe(MIGRATION_PENDING);

    // The last chunk commits and clears the marker — the replacement cohort is
    // complete. Only now may the ratio be stated again.
    const afterBump = foldLocPerDollarCoverage(
      coveredCounts({ migrationPendingSessionCount: 0 }),
      wholeBasis()
    );
    expect(afterBump.state).toBe(COMPLETE);
  });

  /**
   * AC3 — the ISS-6543 invariant: every qualifying deduplicated session cost
   * enters the denominator, INCLUDING no-push / no-merge work.
   *
   * The denominator population is deliberately much larger than the numerator
   * cohort, because most sessions never push and never merge and their cost is
   * still real spend the ratio must divide by. A gate that treated
   * denominator-only sessions as a coverage failure would push the org toward a
   * divisor built only from merged work — which is the inflation, inverted.
   */
  it("does not fault a denominator that is wider than the numerator — no-push work still counts (AC3)", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 2,
        coveredNumeratorSessionCount: 2,
      }),
      // 200 sessions' cost in the divisor, only 2 of which produced merged lines.
      wholeBasis({ denominatorSessionCount: 200 })
    );

    expect(coverage.state).toBe(COMPLETE);
    expect(coverage.denominatorSessionCount).toBe(200);
    expect(coverage.excludedSessionCount).toBe(0);
  });

  /**
   * A probe that did not complete is the AC1 `failed` condition. It must NOT
   * collapse into `complete`: an unanswered coverage question is not a clean
   * bill of health, and folding it that way would publish the very ratio the
   * gate exists to withhold — the distinction-collapse this repo has shipped
   * before.
   */
  it("reports failed, never complete, when the probe did not complete", () => {
    const coverage = foldLocPerDollarCoverage(null, wholeBasis());

    expect(coverage.state).toBe(FAILED);
    expect(coverage.state).not.toBe(COMPLETE);
    // The populations are unknown, not measured — reported as 0 with the state
    // saying how to read them. The BASIS half is still real (it came from the
    // cost split, which succeeded), so it is reported as measured.
    expect(coverage.numeratorSessionCount).toBe(0);
    expect(coverage.excludedSessionCount).toBe(0);
    expect(coverage.denominatorSessionCount).toBe(12);
    expect(coverage.costBasisCoveredUsd).toBe(40);
  });

  it("treats an empty numerator cohort as complete, not as a coverage failure", () => {
    // No merged lines means no ratio to gate — `mergedLocPerDollar` is already
    // null on its own account, and captioning an absent metric with a coverage
    // reason would describe something the card is not showing.
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 0,
        coveredNumeratorSessionCount: 0,
        migrationPendingSessionCount: 0,
        unrevisionedSessionCount: 0,
      }),
      wholeBasis({ costBasisExcludedUsd: 500 })
    );

    expect(coverage.state).toBe(COMPLETE);
  });
});

describe("foldLocPerDollarCoverage — precedence", () => {
  /**
   * More than one condition holds routinely and the reader gets ONE sentence, so
   * the order is a contract. Each case asserts the winner against a cohort where
   * every LOWER-precedence condition is simultaneously true — if the order
   * inverted, each of these would report the condition below it.
   */
  it("ranks migration_pending above every other condition", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 4,
        coveredNumeratorSessionCount: 1,
        migrationPendingSessionCount: 1,
        unrevisionedSessionCount: 3,
      }),
      wholeBasis({ costBasisExcludedUsd: 90 })
    );

    expect(coverage.state).toBe(MIGRATION_PENDING);
  });

  it("ranks stale above missing and the basis narrowing", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 4,
        coveredNumeratorSessionCount: 1,
        unrevisionedSessionCount: 3,
      }),
      wholeBasis({ costBasisExcludedUsd: 90 })
    );

    expect(coverage.state).toBe(STALE);
  });

  it("ranks missing above the basis narrowing", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 4,
        coveredNumeratorSessionCount: 1,
      }),
      wholeBasis({ costBasisExcludedUsd: 90 })
    );

    expect(coverage.state).toBe(MISSING);
  });
});

describe("foldLocPerDollarCoverage — populations exposed to telemetry (AC2)", () => {
  it("carries the numerator, denominator, excluded count, and both sides of the cost basis", () => {
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 7,
        coveredNumeratorSessionCount: 5,
      }),
      wholeBasis({
        denominatorSessionCount: 31,
        costBasisCoveredUsd: 12.5,
        costBasisExcludedUsd: 3.25,
      })
    );

    expect(coverage).toEqual({
      state: MISSING,
      numeratorSessionCount: 7,
      denominatorSessionCount: 31,
      excludedSessionCount: 2,
      costBasisCoveredUsd: 12.5,
      costBasisExcludedUsd: 3.25,
    });
  });

  it("never reports a negative excluded count when the denominator is wider than the numerator scope", () => {
    // AGENTS.md: clamp at both ends. A `covered` count above the numerator count
    // cannot happen through the production probe (the covered set is a subset),
    // but a negative would publish as a nonsensical metric value if it ever did.
    const coverage = foldLocPerDollarCoverage(
      coveredCounts({
        numeratorSessionCount: 2,
        coveredNumeratorSessionCount: 5,
      }),
      wholeBasis()
    );

    expect(coverage.excludedSessionCount).toBe(0);
  });
});
