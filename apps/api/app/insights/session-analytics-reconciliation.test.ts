import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { AgentSessionState } from "@repo/api/src/types/agent-session";
import { LossClass } from "@repo/api/src/types/session-analytics";
import { describe, expect, it } from "vitest";
import {
  type AnalyticsSessionSignals,
  isLostSession,
  isRecoverableWasteBasis,
  lossClassOf,
  outcomeOf,
  TERMINAL_AGENT_SESSION_STATES,
} from "./session-analytics-classify";

/**
 * The ported prototype reconciliation test (`apps/prototypes/app/p/
 * tokenops-waste/reconciliation.test.ts`), strengthened for production.
 *
 * ISS-4987 measures loss in wall-clock and ISS-4988 measures it in dollars, and
 * the two must never disagree about WHICH sessions failed. The prototype
 * asserted that over one generated fixture, so its invariants held partly by
 * how the fixture was constructed. Here the population is the EXHAUSTIVE cross
 * product of every signal combination the classifier can be handed, so the
 * invariants are proved for every reachable input rather than for the cases a
 * fixture happened to emit.
 */

const STATES: readonly (string | null)[] = [
  AgentSessionState.Completed,
  AgentSessionState.Error,
  // Non-terminal. A run still in flight carries `ends_with_error: false` on the
  // desktop write path for the reaper's benefit, so the grid must include these
  // or the classifier's terminal gate is never exercised.
  AgentSessionState.Running,
  AgentSessionState.Blocked,
  null,
];
const ENDS_WITH_ERROR: readonly (boolean | null)[] = [true, false, null];
const BOOLEANS: readonly boolean[] = [true, false];
const WALL_CLOCK_MINUTES: readonly number[] = [0, 42];

/** Every signal combination the rollup queries can produce. */
function buildExhaustivePopulation(): AnalyticsSessionSignals[] {
  const population: AnalyticsSessionSignals[] = [];
  for (const endsWithError of ENDS_WITH_ERROR) {
    for (const hasFailureThrottle of BOOLEANS) {
      for (const producedArtifact of BOOLEANS) {
        for (const state of STATES) {
          for (const wallClockMinutes of WALL_CLOCK_MINUTES) {
            population.push({
              endsWithError,
              hasFailureThrottle,
              producedArtifact,
              state,
              wallClockMinutes,
            });
          }
        }
      }
    }
  }
  return population;
}

const POPULATION = buildExhaustivePopulation();

/** A stable identity per signal combination, standing in for a session id. */
function idOf(signals: AnalyticsSessionSignals): string {
  return [
    String(signals.endsWithError),
    String(signals.hasFailureThrottle),
    String(signals.producedArtifact),
    String(signals.state),
    String(signals.wallClockMinutes),
  ].join("|");
}

function idsWhere(
  predicate: (signals: AnalyticsSessionSignals) => boolean
): Set<string> {
  return new Set(POPULATION.filter(predicate).map(idOf));
}

/**
 * Mirrors the classifier's own gate: a null state is "never recorded", which
 * defers to `endsWithError` rather than being treated as a live run.
 */
function isTerminal(signals: AnalyticsSessionSignals): boolean {
  return (
    signals.state === null ||
    TERMINAL_AGENT_SESSION_STATES.includes(signals.state)
  );
}

describe("one definition of failure across both analytics surfaces", () => {
  it("keys failure on endsWithError once the run has actually ended", () => {
    const erroredIds = idsWhere(
      (signals) => outcomeOf(signals) === SpendOutcome.Errored
    );
    const endsWithErrorIds = idsWhere(
      (signals) => signals.endsWithError === true && isTerminal(signals)
    );
    expect(erroredIds).toEqual(endsWithErrorIds);
  });

  it("never folds an unrecorded or still-running outcome into clean or errored", () => {
    const unknown = POPULATION.filter(
      (signals) => outcomeOf(signals) === SpendOutcome.Unknown
    );
    expect(unknown.length).toBeGreaterThan(0);
    for (const signals of unknown) {
      // Either the flag was never recorded, or the run has not ended yet — both
      // are honestly "no outcome", and neither may borrow a terminal verdict.
      expect(signals.endsWithError === null || !isTerminal(signals)).toBe(true);
    }
  });

  it("never grades a run that has not ended as clean or errored", () => {
    const live = POPULATION.filter((signals) => !isTerminal(signals));
    expect(live.length).toBeGreaterThan(0);
    for (const signals of live) {
      // The defect this gate exists for: a session running right now syncs
      // `endsWithError: false`, and without the terminal check its spend landed
      // in the "Ended clean" bucket for a run that has not ended.
      expect(outcomeOf(signals)).toBe(SpendOutcome.Unknown);
    }
    // And specifically the false-flagged live row, the one that used to read
    // as Clean.
    expect(
      outcomeOf({
        endsWithError: false,
        producedArtifact: false,
        state: AgentSessionState.Running,
        wallClockMinutes: 180,
      })
    ).toBe(SpendOutcome.Unknown);
  });

  it("selects the identical set of failed sessions on the wall-clock side and the cost side", () => {
    // Lost work: every session it grades as Actionable or Systemic loss.
    const lostWorkFailures = idsWhere((signals) => {
      const lossClass = lossClassOf(signals);
      return (
        lossClass === LossClass.Actionable || lossClass === LossClass.Systemic
      );
    });
    // TokenOps: every session inside the recoverable-waste basis.
    const tokenOpsFailures = idsWhere((signals) =>
      isRecoverableWasteBasis(signals)
    );
    expect(lostWorkFailures.size).toBeGreaterThan(0);
    expect(lostWorkFailures).toEqual(tokenOpsFailures);
  });

  it("maps the unattributed loss class one-to-one onto outcome-unknown lost spend", () => {
    const unattributedIds = idsWhere(
      (signals) => lossClassOf(signals) === LossClass.Unattributed
    );
    const unknownLostIds = idsWhere(
      (signals) =>
        outcomeOf(signals) === SpendOutcome.Unknown && isLostSession(signals)
    );
    expect(unattributedIds.size).toBeGreaterThan(0);
    expect(unattributedIds).toEqual(unknownLostIds);
  });

  it("never grades a clean-outcome session as lost work", () => {
    // The production refinement over the prototype predicate. A session that
    // ended cleanly has not lost the work just because it produced no artifact,
    // and admitting it would break both invariants above on real data.
    for (const signals of POPULATION) {
      if (outcomeOf(signals) === SpendOutcome.Clean) {
        expect(isLostSession(signals)).toBe(false);
        expect(lossClassOf(signals)).toBeNull();
      }
    }
  });

  it("assigns every lost session exactly one loss class", () => {
    for (const signals of POPULATION) {
      const lossClass = lossClassOf(signals);
      expect(lossClass === null).toBe(!isLostSession(signals));
    }
  });

  it("never grades a session that consumed no wall-clock as lost", () => {
    for (const signals of POPULATION) {
      if (signals.wallClockMinutes === 0) {
        expect(isLostSession(signals)).toBe(false);
      }
    }
  });

  it("attributes a throttled failure to the platform and an unthrottled one to the run", () => {
    const systemic = POPULATION.filter(
      (signals) => lossClassOf(signals) === LossClass.Systemic
    );
    expect(systemic.length).toBeGreaterThan(0);
    for (const signals of systemic) {
      expect(signals.hasFailureThrottle).toBe(true);
      expect(signals.endsWithError).toBe(true);
    }
    const actionable = POPULATION.filter(
      (signals) => lossClassOf(signals) === LossClass.Actionable
    );
    expect(actionable.length).toBeGreaterThan(0);
    for (const signals of actionable) {
      expect(signals.hasFailureThrottle).toBe(false);
      expect(signals.endsWithError).toBe(true);
    }
  });
});
