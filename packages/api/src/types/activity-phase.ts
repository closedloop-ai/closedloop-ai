/**
 * The activity-phase taxonomy (FEA-2269, PRD-488): the keys the Desktop
 * classifier writes into each activity segment's `phase`, which sync to the
 * cloud verbatim. Shared here (ISS-12552) so `@repo/lib` can
 * read them; the Desktop classifier, scorers and post-passes import them from
 * this module.
 *
 * The taxonomy is stored as data (free TEXT, Q-001): adding or renaming a value
 * is an `ACTIVITY_CLASSIFIER_VERSION` bump plus a backfill re-derive, never a
 * migration. `review` and `rework` are declared-only labels assigned by
 * deterministic post-passes, never by the structural scorer.
 */
export const ACTIVITY_PHASE = {
  Explore: "explore",
  Plan: "plan",
  Implement: "implement",
  /**
   * Performing a review (PRD-488 state-aware). DECLARED-only; assigned by the
   * stateful carry pass when the user REQUESTED a review (a `/code-review`-style
   * command/skill or an NL "review my changes" prompt; see
   * `review-intent-detector.ts`), not scored from git-lifecycle. A relabelled
   * subset of the active phases, so it never breaks the complete-tiling /
   * Σ-reconciliation invariants.
   */
  Review: "review",
  Validate: "validate",
  /**
   * In-session review→fix (FEA-2270). DECLARED-only; assigned only by the
   * `rework-detector.ts` post-pass when an address-review prompt ("address the
   * review comments") is followed by real editing. A relabelled subset of the
   * active phases, so it never breaks the complete-tiling / Σ-reconciliation
   * invariants.
   */
  Rework: "rework",
  /** The honest unclassified-but-active bucket (never a force-fit). */
  Other: "other",
  /** A first-class inactivity kind (Q-005): a labelled gap, not active work. */
  Idle: "idle",
} as const;

export type ActivityPhase =
  (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE];
