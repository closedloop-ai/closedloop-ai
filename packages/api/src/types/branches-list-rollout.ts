/** Branches-specific reasons carried by shared Grid Table health events. */
export const BranchesListRolloutDecisionReason = {
  CompleteCohortRead: "complete_cohort_read",
  HydrationComplete: "hydration_complete",
  HydrationPartial: "hydration_partial",
  ParityAligned: "parity_aligned",
  ParityMismatch: "parity_mismatch",
  ParityUnmeasured: "parity_unmeasured",
  RenderSettled: "render_settled",
} as const;
export type BranchesListRolloutDecisionReason =
  (typeof BranchesListRolloutDecisionReason)[keyof typeof BranchesListRolloutDecisionReason];
