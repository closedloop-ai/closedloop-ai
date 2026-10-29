/**
 * @file agent-session-owed-queues.ts
 * @description What the session lane still OWES: its two queues, the id sets
 * that mirror them, and the live-scan stamp map the durable cursor's prefix
 * boundary is computed from (`agent-session-sync-cursor-prefix.ts`).
 *
 * One subject, in one place, because the read and the removal have to agree:
 * the boundary is the oldest stamp among the owed ids, so a removal that
 * dropped an id from a queue and left its stamp behind would hold the watermark
 * at a row nothing owes any more.
 */
/**
 * ISS-8041: every id a lane still owes. The pinned chunk tail is named
 * explicitly even though its session stays queued until its LAST chunk acks —
 * the boundary may not depend on that being re-derived correctly elsewhere.
 * Materialized, not lazy: `CursorPrefixInput.unackedIds` is read more than
 * once.
 */
export function collectOwedIds(
  incrementalQueue: readonly string[],
  backfillQueue: readonly string[],
  pendingChunkSessionId: string | null
): string[] {
  const owed = [...incrementalQueue, ...backfillQueue];
  if (pendingChunkSessionId !== null) {
    owed.push(pendingChunkSessionId);
  }
  return owed;
}

/**
 * Drop acked or abandoned ids from ONE queue and evict their stamps, answering
 * the queue that remains. The caller assigns it, so a reader that captured the
 * previous array across an await still sees the set it was handed.
 */
export function dequeueOwedIds(
  queue: readonly string[],
  queuedIds: Set<string>,
  queuedUpdatedAtById: Map<string, string>,
  ids: readonly string[]
): string[] {
  const removeIds = new Set(ids);
  for (const id of removeIds) {
    queuedIds.delete(id);
    // ISS-8041: the row is no longer owed, so it must stop holding the cursor
    // back — and this is the one removal path, so it is the one eviction that
    // keeps the map bounded by the queues.
    queuedUpdatedAtById.delete(id);
  }
  return queue.filter((id) => !removeIds.has(id));
}
