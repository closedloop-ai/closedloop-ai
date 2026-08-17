/**
 * @file backfill-queue-feed.ts
 * @description ISS-4546 (ISS-4493 Part 2): the dedup-safe, hydration-first
 * in-memory `backfillQueue` feed the sync service uses to inject session ids that
 * were durably enqueued in the outbox AFTER the sync lane already hydrated for
 * the current identity (today: the data-revision rebuild's sync hand-off,
 * `runDataRevisionSyncEnqueueAndFeed`). Extracted out of the
 * grandfathered `agent-session-sync-service.ts` (over the 1,000-line ceiling)
 * into a cohesive, directly unit-testable sibling so the service does not grow —
 * the service keeps only a thin delegate that hands its own fields through.
 *
 * The dedup logic MIRRORS the `loadPendingOutboxIds` re-enqueue loop in
 * `hydratePersistedCursorIfNeeded` exactly: an id already tracked in
 * `backfillQueuedIds` / `incrementalQueuedIds` / `deadLetteredIds` is skipped,
 * so an injected id that the same-session incremental scan or the initial
 * hydration already queued is never double-queued. Only genuinely-new ids are
 * appended to `backfillQueue` and recorded in `backfillQueuedIds`. (Both paths
 * now call {@link feedIdsIntoBackfillQueue}, so the discipline cannot drift.)
 *
 * HYDRATION-FIRST + IDENTITY-MATCH (correctness — never skip the initial
 * hydration/full-walk, and never inject onto the wrong lane):
 * {@link injectIdsIntoLiveQueue} feeds the live queue ONLY when the caller's
 * captured `capturedSourceKey` still matches BOTH the currently-resolved identity AND
 * the already-hydrated identity. If the compute target flipped during the awaited
 * outbox/marker writes (A enqueued, B hydrated), the captured key no longer
 * matches and the inject is refused — so A's ids can never enter B's live lane and
 * clear B's outbox key while A stays pending. If hydration has not yet run, the
 * ids are left for the pending hydration's own `loadPendingOutboxIds` re-enqueue
 * loop (they are durably in the outbox), so a live inject can NEVER preempt the
 * initial full-walk.
 *
 * DEAD-LETTER RECOVERY (ISS-4546, PR #4098 review, shafty023): an injected id can
 * be one the sync lane previously set aside as a `dead_lettered` straggler. The
 * durable `enqueueOutboxEntries` preserves that status (it never resurrects a row
 * to `pending`), and the plain dedup skip would refuse the id from the live queue
 * — leaving a session that genuinely changed PARKED as a dead-letter, never
 * re-sent. So we first RECOVER any injected id currently set aside as a
 * dead-letter (durably re-pend its outbox row + clear its in-memory dead-letter/
 * failure state) BEFORE the dedup feed, so it becomes eligible to drain this
 * session.
 *
 * ISS-5135 note: this recovery was introduced for the FEA-3427 wall-clock heal,
 * which re-derived sessions the client had already corrected. That heal is gone,
 * but the branch is NOT vestigial — the data-revision rebuild can equally re-derive
 * a session whose outbox row is `dead_lettered`, which is exactly the case above.
 */

/**
 * The mutable in-memory queue state the feed appends to. Matches the private
 * `backfillQueue` array and the dedup-tracking sets on the sync service, so the
 * service passes its own fields straight through.
 */
export type BackfillQueueFeedState = {
  /** The live backfill queue drained by the sync tick. Newly-injected ids are appended. */
  backfillQueue: string[];
  /** Ids already on the backfill queue (dedup guard). */
  backfillQueuedIds: Set<string>;
  /** Ids already on the incremental queue (dedup guard). */
  incrementalQueuedIds: Set<string>;
  /** Ids currently set aside as dead-letters (dedup guard, keyed by id). */
  deadLetteredIds: Map<string, number>;
};

/**
 * The narrow slice of the sync service {@link injectIdsIntoLiveQueue} reaches
 * into — the live queue state plus the identity/lifecycle it needs for the
 * hydration-first + identity-match guard, the dead-letter recovery, and
 * the post-enqueue nudge. Kept structural (not the whole service) so the feed
 * stays directly unit-testable and the service passes `this` straight through, its
 * own fields backing every member.
 */
export type BackfillQueueFeedContext = BackfillQueueFeedState & {
  /** The identity the initial hydration + full-walk has completed for (`null` until then). */
  hydratedSourceKey: string | null;
  /** The source key for the currently-resolved identity (`null` offline/unauthenticated). */
  resolveSyncSourceKey(): string | null;
  /**
   * ISS-4546 (PR #4098 review, shafty023): durably re-pend the given id's
   * `dead_lettered` outbox row back to `pending` and clear its in-memory
   * dead-letter/failure state, so an injected id the sync lane had set aside
   * becomes eligible for the live queue again (mirrors `promoteDeadLetterIfIdle`'s
   * recovery). Called ONLY for an id that is currently in `deadLetteredIds`.
   */
  recoverDeadLetteredId(id: string): void;
  /**
   * Clear the dead-letter revisit guard when new durable work lands, so
   * live/backfill drains before a dead-letter revisit — mirroring the
   * `loadPendingOutboxIds` re-enqueue loop.
   */
  resetDeadLetterRevisitGuard(): void;
  /** Nudge the sync loop so the injected ids drain this session (no restart). */
  nudgeAfterInject(): void;
};

/**
 * ISS-4546: append `ids` to the live `backfillQueue`, skipping any id already
 * tracked in `backfillQueuedIds`, `incrementalQueuedIds`, or `deadLetteredIds`
 * — the exact dedup discipline of the `loadPendingOutboxIds` re-enqueue loop.
 * Returns the count of ids that were genuinely newly enqueued (0 when every id
 * was already tracked), so the caller can decide whether follow-on state (e.g.
 * the dead-letter revisit guard) needs resetting and whether to log.
 */
export function feedIdsIntoBackfillQueue(
  state: BackfillQueueFeedState,
  ids: readonly string[]
): number {
  let enqueued = 0;
  for (const id of ids) {
    if (
      state.backfillQueuedIds.has(id) ||
      state.incrementalQueuedIds.has(id) ||
      state.deadLetteredIds.has(id)
    ) {
      continue;
    }
    state.backfillQueuedIds.add(id);
    state.backfillQueue.push(id);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * ISS-4546 (ISS-4493 Part 2): the full inject orchestration the sync service's
 * `injectBackfillIds` delegates to. Applies the HYDRATION-FIRST + IDENTITY-MATCH
 * guard, RECOVERS any injected id currently set aside as a dead-letter (see the
 * re-pend), appends dedup-safe via {@link feedIdsIntoBackfillQueue}, and — only
 * when new ids actually landed — resets the dead-letter revisit guard, logs, and
 * nudges the loop so the injected ids drain this session. A no-op when there are
 * no ids, the captured identity no longer matches, or every id was already
 * tracked (and none needed dead-letter recovery).
 *
 * HYDRATION-FIRST + IDENTITY-MATCH: feed only when the caller's `capturedSourceKey`
 * (captured at enqueue time) still equals BOTH the currently-resolved source key
 * AND `ctx.hydratedSourceKey`. Until hydration has run, the initial full walk has
 * not; its `loadPendingOutboxIds` loop will pick these durable ids up — injecting
 * now would push them ahead of that walk. If the compute target flipped mid-await
 * (A enqueued, B hydrated), the captured key no longer matches the live/hydrated
 * key, so A's ids are refused rather than injected onto B's lane (thread 1).
 */
export function injectIdsIntoLiveQueue(
  ctx: BackfillQueueFeedContext,
  ids: readonly string[],
  capturedSourceKey: string | null,
  log: (message: string) => void
): void {
  if (ids.length === 0) {
    return;
  }
  const sourceKey = ctx.resolveSyncSourceKey();
  // IDENTITY-MATCH: the captured source key must still be the resolved
  // identity AND the hydrated identity. A null captured key (offline enqueue) can
  // never match a live lane, so it is refused too.
  if (
    capturedSourceKey === null ||
    sourceKey === null ||
    sourceKey !== capturedSourceKey ||
    capturedSourceKey !== ctx.hydratedSourceKey
  ) {
    return;
  }
  // DEAD-LETTER RECOVERY (shafty023): re-pend any injected id the sync lane had
  // set aside as a dead-letter BEFORE the dedup feed, so a genuinely-changed
  // session is no longer refused from the live queue and left parked as a
  // dead-letter. Recovery clears it from `deadLetteredIds` so
  // `feedIdsIntoBackfillQueue` below then queues it as genuinely-new work.
  for (const id of ids) {
    if (ctx.deadLetteredIds.has(id)) {
      ctx.recoverDeadLetteredId(id);
    }
  }
  const enqueued = feedIdsIntoBackfillQueue(ctx, ids);
  if (enqueued === 0) {
    return;
  }
  // New durable work to drain preempts dead-letter revisits, mirroring the
  // `loadPendingOutboxIds` re-enqueue loop.
  ctx.resetDeadLetterRevisitGuard();
  log(`injected ${enqueued} session(s) into the live backfill queue`);
  ctx.nudgeAfterInject();
}
