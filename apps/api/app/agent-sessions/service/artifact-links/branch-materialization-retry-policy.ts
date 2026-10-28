/** Closed retry policy shared by synchronous enqueue and scheduled drain. */
export const BranchMaterializationRetryPolicy = {
  MaxAttempts: 8,
  BaseDelayMs: 60 * 1000,
  MaxFallbackDelayMs: 30 * 60 * 1000,
  MaxHorizonMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Retryable branch materialization outcomes persisted before the drain runs. */
export const BranchMaterializationRetryReason = {
  AuthorityUnavailable: "authority_unavailable",
} as const;
export type BranchMaterializationRetryReason =
  (typeof BranchMaterializationRetryReason)[keyof typeof BranchMaterializationRetryReason];
