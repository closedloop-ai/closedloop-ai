/**
 * @file trace-comment-sync-status-contract.ts
 * @description The trace-comment lane's sync vocabulary, in one place.
 *
 * The trace-comment lane is the fifth desktop→cloud sync state machine
 * (`main/sync/AGENTS.md`). Unlike the two outboxes and the transcript ledger it
 * keeps no separate queue table: a comment's delivery state lives on the entity
 * row in `trace_comments.sync_status`, for offline-authoring atomicity. That is
 * a difference in STORAGE SHAPE, not a statement that the lane owes nothing —
 * a `local_pending` comment is undelivered local work exactly like a pending
 * outbox row.
 *
 * These values previously existed only as bare string literals inside a
 * 1,600-line main-process store, which is precisely the copy-paste drift
 * `main/sync/AGENTS.md` was written to stop. They live here now, node-free, to
 * match the `sync-lane-contract.ts` / `transcript-sync-status-contract.ts`
 * precedent, so the store that DRAINS the lane and the burn-down that MEASURES
 * it cannot disagree about what "pending" means.
 */

/**
 * Delivery lifecycle stored on `trace_comments.sync_status`.
 *
 * The `*_update` / `*_delete` pairs distinguish WHICH CRUD operation is owed, so
 * a failed delete is not retried as a create. `Synced` is the only settled
 * value. There is deliberately no dead-letter member: this lane has no give-up
 * state, so a permanently-rejected comment retries indefinitely rather than
 * being abandoned.
 */
export const TraceCommentSyncStatus = {
  Synced: "synced",
  LocalPending: "local_pending",
  SyncFailed: "sync_failed",
  LocalPendingUpdate: "local_pending_update",
  SyncFailedUpdate: "sync_failed_update",
  LocalPendingDelete: "local_pending_delete",
  SyncFailedDelete: "sync_failed_delete",
} as const;
export type TraceCommentSyncStatus =
  (typeof TraceCommentSyncStatus)[keyof typeof TraceCommentSyncStatus];

/**
 * Per-REPLY statuses. These only ever appear inside the row's `replies` JSON
 * blob and are never written to the `sync_status` column, so they are kept apart
 * from {@link TraceCommentSyncStatus} rather than widening it with members the
 * column can never hold.
 */
export const TraceCommentReplySyncStatus = {
  LocalPendingReply: "local_pending_reply",
  SyncFailedReply: "sync_failed_reply",
} as const;
export type TraceCommentReplySyncStatus =
  (typeof TraceCommentReplySyncStatus)[keyof typeof TraceCommentReplySyncStatus];

/**
 * Every column status that means "this comment still owes the cloud something".
 * The single source of truth for the lane's pending predicate — the drain query
 * and the burn-down both read this list.
 */
export const PENDING_TRACE_COMMENT_SYNC_STATUSES: readonly TraceCommentSyncStatus[] =
  [
    TraceCommentSyncStatus.LocalPending,
    TraceCommentSyncStatus.SyncFailed,
    TraceCommentSyncStatus.LocalPendingUpdate,
    TraceCommentSyncStatus.SyncFailedUpdate,
    TraceCommentSyncStatus.LocalPendingDelete,
    TraceCommentSyncStatus.SyncFailedDelete,
  ];

/** Pending statuses that live only inside the `replies` JSON. */
export const PENDING_TRACE_COMMENT_REPLY_SYNC_STATUSES: readonly TraceCommentReplySyncStatus[] =
  [
    TraceCommentReplySyncStatus.LocalPendingReply,
    TraceCommentReplySyncStatus.SyncFailedReply,
  ];

/** Statuses whose row is hidden from the UI because a delete is owed. */
export const HIDDEN_TRACE_COMMENT_SYNC_STATUSES: readonly TraceCommentSyncStatus[] =
  [
    TraceCommentSyncStatus.LocalPendingDelete,
    TraceCommentSyncStatus.SyncFailedDelete,
  ];

const TRACE_COMMENT_SYNC_STATUS_VALUES = new Set<string>(
  Object.values(TraceCommentSyncStatus)
);

const PENDING_TRACE_COMMENT_SYNC_STATUS_VALUES = new Set<string>(
  PENDING_TRACE_COMMENT_SYNC_STATUSES
);

/**
 * Narrow an unconstrained DB `sync_status` string to a known member, else null.
 * The column is TEXT with no CHECK, so a row from another build can carry
 * anything; callers decide the fallback rather than inheriting a silent
 * mislabel.
 */
export function asTraceCommentSyncStatus(
  value: string
): TraceCommentSyncStatus | null {
  return TRACE_COMMENT_SYNC_STATUS_VALUES.has(value)
    ? (value as TraceCommentSyncStatus)
    : null;
}

/** Does this known status still owe the cloud a delivery? */
export function isPendingTraceCommentSyncStatus(
  status: TraceCommentSyncStatus
): boolean {
  return PENDING_TRACE_COMMENT_SYNC_STATUS_VALUES.has(status);
}
