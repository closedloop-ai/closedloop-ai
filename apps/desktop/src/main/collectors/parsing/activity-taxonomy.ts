/**
 * @file activity-taxonomy.ts
 * @description FEA-2269 (PRD-488): the activity-phase taxonomy — the SSOT const
 * object shared by the classifier (`activity-segment-classifier.ts`) and the pure
 * scorers (`activity-scoring.ts`). It lives in its own leaf module so both can
 * import it WITHOUT an import cycle (the classifier imports the scorers, and the
 * scorers need the phase labels).
 *
 * The taxonomy is stored as DATA (a free TEXT column in `session_activity_segments`,
 * Q-001): adding/renaming a value is an `ACTIVITY_CLASSIFIER_VERSION` bump +
 * backfill re-derive, never a DB migration. Const-object enum per AGENTS.md
 * (Biome forbids the TypeScript `enum`).
 *
 * v1 (FEA-2269, Q-001 ratified 2026-06-29): the five active-work labels + the
 * honest `other` bucket + the first-class `idle` kind inherited from FEA-2267's
 * store contract. `rework` is FEA-2270 (deliberately NOT here — FEA-2269 emits the
 * 6-type set without it); `linguistic`-driven labels are FEA-2274.
 */

export const ACTIVITY_PHASE = {
  Explore: "explore",
  Plan: "plan",
  Implement: "implement",
  Review: "review",
  Validate: "validate",
  /** The honest unclassified-but-active bucket (never a force-fit). */
  Other: "other",
  /** A first-class inactivity kind (Q-005) — a labelled gap, not active work. */
  Idle: "idle",
} as const;

export type ActivityPhase =
  (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE];

/**
 * The active-work phases in a fixed, deterministic order. Two uses, both
 * load-bearing for determinism:
 *  1. It is the argmax tie-break — when two phases score equal, the earlier entry
 *     wins, so a tie always resolves to the SAME phase (never argmax/Map
 *     iteration order).
 *  2. The scorer maps this array 1:1 onto its per-phase score functions.
 * Excludes `other` (the sub-floor fallback) and `idle` (a gap kind the store
 * owns), neither of which is ever a scored label.
 */
export const ACTIVE_PHASE_ORDER = [
  ACTIVITY_PHASE.Explore,
  ACTIVITY_PHASE.Plan,
  ACTIVITY_PHASE.Implement,
  ACTIVITY_PHASE.Review,
  ACTIVITY_PHASE.Validate,
] as const satisfies readonly ActivityPhase[];
