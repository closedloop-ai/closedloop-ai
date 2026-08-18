import type { AgentCoachingLever } from "./agent-coaching-scoring";

/**
 * FEA-4179: the per-lever "is this lever warranted by the user's real usage?"
 * gate — the SINGLE source of truth for the determinism thresholds the coaching
 * paths enforce.
 *
 * The deterministic seed builders (agent-coaching-model.ts / -dimensions.ts)
 * each drop their candidate (return `null`) when the user's metrics don't clear
 * a per-lever floor, so a lever only surfaces when real usage warrants it. The
 * LLM-generated path used to bypass that entirely — a nonempty generated batch
 * REPLACES the seed tips, so any lever the model emitted (a "you're not using
 * plan mode" cost/wall-time tip, a "make a skill" reuse tip, …) could reach a
 * user whose usage doesn't justify it.
 *
 * These predicates factor the seed builders' threshold comparisons out of the
 * builders so BOTH paths call the exact same check: the builders gate their
 * `null`-return here, and the generated path filters out any tip whose lever is
 * not warranted (see `warrantedLeversForInput` in agent-coaching-model.ts). The
 * thresholds live here and NOWHERE else — do not re-inline them at a builder or
 * duplicate them for the generated path.
 *
 * Each predicate is pure over already-computed signals (never over the raw
 * `AgentCoachingInput`) so it has no dependency on the signal-extraction helpers
 * and cannot introduce an import cycle. The caller computes the signal the way
 * the builder already does and passes it here.
 */

/**
 * Every lever the gate covers, keyed by the lever union. This is a
 * `Record<AgentCoachingLever, true>`, so it is exhaustive in BOTH directions: a
 * stale key that is no longer in the union is a typecheck error, AND a newly
 * added union member (e.g. FEA-4153's `capability_gap`) makes this object
 * missing a required key and fails typecheck until it is listed here — which a
 * plain `satisfies readonly AgentCoachingLever[]` array does NOT catch (an array
 * only validates the members present, so a new union member could compile while
 * silently never reaching `ALL_COACHING_LEVERS` and being filtered out of every
 * generated batch). Same exhaustiveness discipline as `leverWarranted`'s switch.
 */
const COACHING_LEVER_REGISTRY: Record<AgentCoachingLever, true> = {
  capability_gap: true,
  context_hygiene: true,
  cost: true,
  harness_routing: true,
  resilience: true,
  reuse: true,
  test_sequencing: true,
  wall_time: true,
};

/**
 * Every lever the gate covers, derived from the exhaustive registry above.
 * Iterated by `warrantedLeversForInput` to gate the generated path over ALL
 * levers, not a hand-picked subset.
 */
export const ALL_COACHING_LEVERS = Object.keys(
  COACHING_LEVER_REGISTRY
) as AgentCoachingLever[];

/** Context hygiene floors (agent-coaching-model buildContextCandidate). */
const CONTEXT_MIN_AVG_EVENTS = 50;
const CONTEXT_MIN_AVG_TOKENS = 15_000;
/** Accuracy / test-sequencing floor (buildAccuracyCandidate). */
const TEST_SEQUENCING_MIN_DELEGATIONS = 3;
/** Harness-routing floor (buildHarnessCandidate). */
const HARNESS_ROUTING_MIN_DISTINCT_MODES = 2;
/** Wall-time floor (agent-coaching-dimensions buildWallTimeCandidate). */
const WALL_TIME_MIN_SECONDS = 600;
/** Cost floors (agent-coaching-dimensions buildCostCandidate). */
const COST_MIN_TOKENS = 50_000;
const COST_MIN_ESTIMATED_USD = 5;

/** Signals the context-hygiene gate needs. */
export type ContextLeverSignals = {
  totalSessions: number;
  averageEvents: number;
  averageTokens: number;
};

/** Signals the reuse gate needs (workflow + token-efficiency builders share it). */
export type ReuseLeverSignals = {
  /** A repeated shell-command family cleared the builder's own count floor. */
  hasReusableCommandCandidate: boolean;
  /** Total local skill invocations. */
  skillCount: number;
  /** A shell-family tool row exists to consolidate (token-efficiency fallback). */
  hasShellTool: boolean;
};

/** Signals the accuracy / test-sequencing gate needs. */
export type TestSequencingLeverSignals = {
  generalCount: number;
  testCount: number;
};

/** Signals the cost gate needs. */
export type CostLeverSignals = {
  totalTokens: number;
  estimatedCostUsd: number | null;
};

/** Context hygiene is warranted once per-session load clears either floor. */
export function contextLeverWarranted(signals: ContextLeverSignals): boolean {
  return (
    signals.totalSessions > 0 &&
    (signals.averageEvents >= CONTEXT_MIN_AVG_EVENTS ||
      signals.averageTokens >= CONTEXT_MIN_AVG_TOKENS)
  );
}

/**
 * Reuse is warranted when there is something durable to promote: a repeated
 * command family, prior skill usage, or (token-efficiency fallback) a shell tool
 * to consolidate. Mirrors the two seed builders' combined gates so the shared
 * `reuse` lever surfaces from the generated path on the same evidence.
 */
export function reuseLeverWarranted(signals: ReuseLeverSignals): boolean {
  return (
    signals.hasReusableCommandCandidate ||
    signals.skillCount > 0 ||
    signals.hasShellTool
  );
}

/** Accuracy / test sequencing needs enough delegations on either side. */
export function testSequencingLeverWarranted(
  signals: TestSequencingLeverSignals
): boolean {
  return (
    signals.generalCount >= TEST_SEQUENCING_MIN_DELEGATIONS ||
    signals.testCount >= TEST_SEQUENCING_MIN_DELEGATIONS
  );
}

/** Harness routing needs genuinely different work modes in the tool mix. */
export function harnessRoutingLeverWarranted(distinctModes: number): boolean {
  return distinctModes >= HARNESS_ROUTING_MIN_DISTINCT_MODES;
}

/** Resilience is warranted only when a confident frustration peak exists. */
export function resilienceLeverWarranted(hasPeakFrustration: boolean): boolean {
  return hasPeakFrustration;
}

/** Wall time is warranted once average session wall-clock clears the floor. */
export function wallTimeLeverWarranted(
  avgSessionDurationSec: number | null
): boolean {
  return (
    avgSessionDurationSec != null &&
    avgSessionDurationSec >= WALL_TIME_MIN_SECONDS
  );
}

/**
 * Cost is warranted once token spend clears the floor AND — when a dollar
 * estimate exists — it clears the spend floor too, so a "cut spend" tip never
 * opens with a sub-dollar figure. A null estimate still qualifies on tokens.
 */
export function costLeverWarranted(signals: CostLeverSignals): boolean {
  if (signals.totalTokens < COST_MIN_TOKENS) {
    return false;
  }
  return (
    signals.estimatedCostUsd == null ||
    signals.estimatedCostUsd >= COST_MIN_ESTIMATED_USD
  );
}

/**
 * FEA-4153: the capability-gap lever is warranted once the user's usage exposes
 * at least one genuine best-practice gap. The per-capability floors (min
 * sessions/shell samples/repeated families, healthy-adoption ratios) live in
 * `agent-coaching-capability-gap`'s `detect`s and are already applied when this
 * boolean is computed, so the gate reads a single grounded signal here.
 */
export function capabilityGapLeverWarranted(
  hasCapabilityGap: boolean
): boolean {
  return hasCapabilityGap;
}

/**
 * FEA-4179: all metrics-derived signals the per-lever gates score against,
 * computed once from the user's input/metrics and passed to `leverWarranted`.
 * The seed builders each recompute only the slice they need; this bundles every
 * slice so the generated-tip filter can gate ANY lever a tip carries.
 */
export type LeverSignals = {
  context: ContextLeverSignals;
  reuse: ReuseLeverSignals;
  testSequencing: TestSequencingLeverSignals;
  harnessDistinctModes: number;
  hasPeakFrustration: boolean;
  avgSessionDurationSec: number | null;
  cost: CostLeverSignals;
  /**
   * FEA-4153 capability gap: whether the user's real usage exposes at least one
   * best-practice capability they are provably not adopting yet (plan mode, rtk
   * routing, skills). The caller runs the same capability-gap detection the seed
   * builder uses (`buildCapabilityGapCandidates`) and passes its "any gap
   * detected" result here, so the generated path gates the `capability_gap`
   * lever on the exact evidence the seed path scores.
   */
  hasCapabilityGap: boolean;
};

/**
 * Is `lever` warranted by the user's actual usage? Exhaustive over the lever
 * union (FEA-4153's `capability_gap` lever has its arm below and its signal on
 * `LeverSignals`). The generated path uses this to drop ungrounded tips; the
 * seed builders gate their own `null`-return through the same per-lever
 * predicates above.
 */
export function leverWarranted(
  lever: AgentCoachingLever,
  signals: LeverSignals
): boolean {
  switch (lever) {
    case "context_hygiene":
      return contextLeverWarranted(signals.context);
    case "reuse":
      return reuseLeverWarranted(signals.reuse);
    case "test_sequencing":
      return testSequencingLeverWarranted(signals.testSequencing);
    case "harness_routing":
      return harnessRoutingLeverWarranted(signals.harnessDistinctModes);
    case "resilience":
      return resilienceLeverWarranted(signals.hasPeakFrustration);
    case "wall_time":
      return wallTimeLeverWarranted(signals.avgSessionDurationSec);
    case "cost":
      return costLeverWarranted(signals.cost);
    case "capability_gap":
      return capabilityGapLeverWarranted(signals.hasCapabilityGap);
    default: {
      // Exhaustiveness guard: a new lever must add an arm above, not fall
      // through to a silent "warranted".
      const _exhaustive: never = lever;
      return Boolean(_exhaustive);
    }
  }
}
