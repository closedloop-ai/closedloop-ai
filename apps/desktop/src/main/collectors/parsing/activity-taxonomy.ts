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
 * store contract. `linguistic`-driven labels are FEA-2274.
 *
 * `rework` (FEA-2270) and `review` (PRD-488 state-aware) are DECLARED-only labels
 * — the structural scorer never argmaxes to either (both are absent from
 * {@link ACTIVE_PHASE_ORDER}). They are produced only by deterministic post-passes
 * that relabel active segments the scorer already emitted: `review` when the user
 * REQUESTED a review (`review-intent-detector.ts` + the stateful carry pass), and
 * `rework` when the user asked to ADDRESS a review (`rework-detector.ts`). Keeping
 * them out of `ACTIVE_PHASE_ORDER` preserves the structural scorer's semantics:
 * the post-passes add these labels, they do not compete for the argmax. (`review`
 * used to be scored from git-lifecycle; the state-aware model makes git AMBIENT,
 * so a commit/push/PR now inherits the current phase instead of forcing `review`.)
 */

export const ACTIVITY_PHASE = {
  Explore: "explore",
  Plan: "plan",
  Implement: "implement",
  /**
   * Performing a review (PRD-488 state-aware). DECLARED-only — assigned by the
   * stateful carry pass when the user REQUESTED a review (a `/code-review`-style
   * command/skill or an NL "review my changes" prompt; see
   * `review-intent-detector.ts`), not scored from git-lifecycle. A relabelled
   * subset of the active phases, so it never breaks the complete-tiling /
   * Σ-reconciliation invariants.
   */
  Review: "review",
  Validate: "validate",
  /**
   * In-session review→fix (FEA-2270). DECLARED-only — assigned only by the
   * `rework-detector.ts` post-pass when an address-review prompt ("address the
   * review comments") is followed by real editing. A relabelled subset of the
   * active phases, so it never breaks the complete-tiling / Σ-reconciliation
   * invariants.
   */
  Rework: "rework",
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
 * owns), plus the DECLARED-only labels `review` and `rework` (assigned by
 * post-passes, never argmax'd) — none of which is ever a scored label.
 */
export const ACTIVE_PHASE_ORDER = [
  ACTIVITY_PHASE.Explore,
  ACTIVITY_PHASE.Plan,
  ACTIVITY_PHASE.Implement,
  ACTIVITY_PHASE.Validate,
] as const satisfies readonly ActivityPhase[];
