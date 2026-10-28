/**
 * ISS-11212 (PLN-2120 decision 5): the trace-comment dead letter (ISS-10382)
 * lives in `CommentSyncState`, as the thread's DESKTOP / INBOUND row. `ABANDONED`
 * means the desktop outbox gave up delivering the comment's latest edit.
 */
import {
  CommentSyncDirection,
  CommentSyncProvider,
  CommentSyncStatus,
} from "@repo/api/src/types/comment-thread-dto";
import type { Prisma, TransactionClient } from "@repo/database";

/** The sync rows a trace-comment read selects: only the dead-letter row. */
export const traceCommentSyncStatesSelect = {
  where: {
    provider: CommentSyncProvider.Desktop,
    direction: CommentSyncDirection.Inbound,
  },
  select: { state: true },
} satisfies Prisma.CommentThread$syncStatesArgs;

export type TraceCommentSyncStateRow = { state: CommentSyncStatus };

export function isTraceCommentSyncAbandoned(
  syncStates: readonly TraceCommentSyncStateRow[]
): boolean {
  return syncStates.some((row) => row.state === CommentSyncStatus.Abandoned);
}

/**
 * The `syncAbandoned` field a mapped trace comment carries, or nothing at all.
 *
 * `{}` rather than `{ syncAbandoned: false }` because the wire contract omits the
 * key on every row that is not dead-lettered, and the rail keys its badge on
 * `=== true`. Mirrors `abandonedField` in the desktop store's row mappers, so the
 * two shells emit an identical shape for an identical state.
 */
export function traceCommentSyncAbandonedField(
  syncStates: readonly TraceCommentSyncStateRow[]
): { syncAbandoned?: true } {
  return isTraceCommentSyncAbandoned(syncStates) ? { syncAbandoned: true } : {};
}

/**
 * Records the dead letter (`ABANDONED`) on the thread's DESKTOP / INBOUND row.
 * Each statement is conditional, so a desktop re-reporting a row that is
 * already `ABANDONED` writes nothing.
 *
 * `false` when the row was already `ABANDONED`: nothing is written.
 */
export async function abandonTraceCommentSync(
  tx: TransactionClient,
  input: { organizationId: string; threadId: string }
): Promise<boolean> {
  const moved = await tx.commentSyncState.updateMany({
    where: {
      threadId: input.threadId,
      provider: CommentSyncProvider.Desktop,
      direction: CommentSyncDirection.Inbound,
      state: { not: CommentSyncStatus.Abandoned },
    },
    data: { state: CommentSyncStatus.Abandoned },
  });
  if (moved.count > 0) {
    return true;
  }
  const created = await tx.commentSyncState.createMany({
    data: {
      organizationId: input.organizationId,
      threadId: input.threadId,
      provider: CommentSyncProvider.Desktop,
      direction: CommentSyncDirection.Inbound,
      state: CommentSyncStatus.Abandoned,
    },
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * PLN-2121 `retrySync`: a dead-lettered comment goes back to `PENDING` with its
 * attempts reset. The move is conditional on the row still being `ABANDONED`
 * when it is written, so an edit that cleared the dead letter after the
 * caller's read is not overwritten.
 *
 * `false` when nothing was dead-lettered at write time: nothing is written.
 */
export async function retryTraceCommentSync(
  tx: TransactionClient,
  input: {
    threadId: string;
    syncStates: readonly TraceCommentSyncStateRow[];
  }
): Promise<boolean> {
  if (!isTraceCommentSyncAbandoned(input.syncStates)) {
    return false;
  }
  const repended = await tx.commentSyncState.updateMany({
    where: {
      threadId: input.threadId,
      provider: CommentSyncProvider.Desktop,
      direction: CommentSyncDirection.Inbound,
      state: CommentSyncStatus.Abandoned,
    },
    data: { state: CommentSyncStatus.Pending, attempts: 0 },
  });
  return repended.count > 0;
}

/**
 * ISS-10382: a successful edit is evidence the delivery state is stale, so it
 * settles the row `SYNCED`.
 *
 * The row is a fact about the LAST delivery attempt of this comment. When the
 * author's update dead-letters and they then edit the same comment again
 * through a path that lands, the cloud row is current and correct — and without
 * this the badge keeps asserting a failure that is no longer true until someone
 * clicks Retry on a comment with nothing left to retry. The same edit is how a
 * retried (`PENDING`) comment's redelivery lands, and nothing else settles it.
 *
 * ROOT ONLY, and the CALLER owns that check: the budget is charged per root row,
 * so a reply's edit says nothing about the root's delivery. Conditional on the
 * row not already being `SYNCED`, so an ordinary edit writes nothing here.
 */
export async function settleTraceCommentSyncOnEdit(
  tx: TransactionClient,
  input: {
    organizationId: string;
    threadId: string;
    syncStates: readonly TraceCommentSyncStateRow[];
  }
): Promise<void> {
  if (!input.syncStates.some((row) => row.state !== CommentSyncStatus.Synced)) {
    return;
  }
  const data = { state: CommentSyncStatus.Synced };
  await tx.commentSyncState.upsert({
    where: {
      threadId_provider_direction: {
        threadId: input.threadId,
        provider: CommentSyncProvider.Desktop,
        direction: CommentSyncDirection.Inbound,
      },
    },
    create: {
      organizationId: input.organizationId,
      threadId: input.threadId,
      provider: CommentSyncProvider.Desktop,
      direction: CommentSyncDirection.Inbound,
      ...data,
    },
    update: data,
    select: { id: true },
  });
}
