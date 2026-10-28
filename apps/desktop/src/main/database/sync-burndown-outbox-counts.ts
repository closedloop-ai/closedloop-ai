import type { SyncLaneRemainderBasis } from "../../shared/sync-burndown-contract.js";

/** Reconciled queue depth for one outbox-shaped sync lane. */
export type OutboxBurndownCounts = {
  remainderBasis: SyncLaneRemainderBasis;
  pending: number;
  /** Pending rows whose backoff deadline has elapsed. */
  readyPending: number;
  deadLettered: number;
  /** Rows explicitly withheld because they are not yet owed. */
  withheld: number;
  /** Oldest pending enqueue timestamp, or null when not fully observable. */
  oldestPendingSinceIso: string | null;
  /** Persisted rows whose status this build cannot classify. */
  unmeasuredRows: number;
};
