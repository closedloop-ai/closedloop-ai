/**
 * @file data-revision-sync-enqueue.ts
 * @description The data-revision rebuild's sync hand-off: enqueue the sessions the
 * rebuild actually changed into the durable sync outbox under the identity captured
 * at the top of the maintenance pass, then feed the confirmed ids into the sync
 * service's LIVE backfill queue so they drain this session instead of waiting for
 * the next restart's hydration.
 *
 * Extracted out of the grandfathered `agent-dashboard-design-system-runtime.ts`
 * (over the 1,000-line ceiling — PR #4098 review) so the runtime keeps only a thin
 * one-line call.
 *
 * ISS-5135 retired the FEA-3427 wall-clock heal this module used to carry. That
 * heal folded extra "stale cloud duration" candidates into the enqueued set and
 * recorded a durable per-(sourceKey, DATA_REVISION) completion marker; both are
 * gone. What remains — and what was always the load-bearing part — is the
 * changed-session enqueue and the live-queue feed, which the rebuild depends on
 * regardless of any heal. The file was called `wall-clock-heal-enqueue.ts` while
 * the heal rode along; the name now matches what it actually does.
 *
 * Two identity guards survive from ISS-4493, because they protect the
 * changed-session enqueue itself and not the heal — but their reach differs, and
 * the difference is worth stating precisely:
 *  - the compute target is captured ONCE and re-checked against the live target
 *    before enqueuing. NOTE: retiring the heal removed the two awaited candidate/
 *    marker reads that used to sit between the caller's capture and this
 *    re-check, so with the current caller (`post-boot-maintenance.ts`, whose
 *    `resolveComputeTargetId` is synchronous) there is no longer a window for the
 *    target to drift and this check cannot fire. It is kept as defense-in-depth
 *    for any caller that captures earlier — NOT as protection for the rebuild
 *    itself, which completes before the capture.
 *  - the captured source key is threaded into the live inject, so the sync service
 *    can refuse ids that no longer match the live+hydrated identity. This one IS
 *    load-bearing: the awaited durable outbox write sits between capture and
 *    inject, so the identity really can move underneath it.
 */
import { AgentSessionSyncClass } from "../agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../agent-sync/agent-session-sync-source.js";

/**
 * The durable-outbox enqueue surface {@link runDataRevisionSyncEnqueueAndFeed}
 * needs: append `backfill` outbox rows for a set of changed session ids under a
 * source key. Matches the `AgentSessionSyncSource.enqueueOutboxEntries` shape.
 */
export type DataRevisionOutboxEnqueue = (
  sourceKey: string,
  entries: { externalSessionId: string; syncClass: AgentSessionSyncClass }[]
) => void | Promise<void>;

export type RunDataRevisionSyncEnqueueInput = {
  /** Sessions the data-revision rebuild actually changed. */
  changedSessionIds: readonly string[];
  /**
   * The compute-target id CAPTURED once at the top of the maintenance pass (online
   * -aware; `null` offline/unauthenticated). Re-checked against the live target
   * before the enqueue so the ids can never land under a different identity than
   * the one they were resolved for (ISS-4493 thread 1).
   */
  capturedComputeTargetId: string | null;
  /** The durable-outbox enqueue delegate, or `undefined` for a legacy/fake source. */
  enqueueOutboxEntries: DataRevisionOutboxEnqueue | undefined;
  /**
   * Re-resolves the LIVE (online-aware) compute target so the enqueue can no-op on
   * a target/account switch (ISS-4493 thread 1). See the header: with the current
   * caller there is no await between its capture and this re-resolve, so this is
   * defense-in-depth for a caller that captures earlier, not a live guard today.
   */
  resolveLiveComputeTargetId: () => string | null;
  /**
   * Feeds the confirmed-enqueued ids into the sync service's LIVE backfill queue so
   * they drain this session. The key derived from the CAPTURED target is passed
   * through so
   * the service refuses the inject unless it still matches the live+hydrated
   * identity (PR #4098 review, wongk). Omitted for contexts without a sync service.
   */
  injectSyncBackfillIds:
    | ((ids: readonly string[], sourceKey: string | null) => void)
    | undefined;
  /**
   * Cancellation gate. Re-checked AFTER the awaited enqueue so a maintenance
   * generation cancelled during the await (stop/restart/close) does not inject or
   * nudge sync work (PR #4098 review, shafty023). Returns `false` when the
   * generation was superseded.
   */
  shouldContinue: () => boolean;
  /** Non-fatal diagnostic sink (the collectors log). */
  log: (message: string) => void;
};

/**
 * Enqueue the rebuild's changed sessions into the durable outbox under the captured
 * identity, then — ONLY if the maintenance generation was not cancelled while that
 * was awaited — feed the confirmed ids into the live backfill queue under the same
 * captured source key.
 */
export async function runDataRevisionSyncEnqueueAndFeed(
  input: RunDataRevisionSyncEnqueueInput
): Promise<void> {
  // ISS-5135: derived here rather than accepted as a second input field. It is
  // ALWAYS `buildAgentSessionSyncSourceKey(capturedComputeTargetId)`, and nothing
  // checked the pair agreed — a mismatched pair would have written outbox rows
  // under key A while the drift check passed on target B, leaving ids durably
  // enqueued under a key nothing drains.
  const capturedSourceKey = input.capturedComputeTargetId
    ? buildAgentSessionSyncSourceKey(input.capturedComputeTargetId)
    : null;

  if (input.changedSessionIds.length === 0) {
    // Nothing changed: no outbox row to write and nothing to inject. One guard, at
    // the top — the old code returned a "confirmed online, nothing to send" `true`
    // from the enqueue helper purely so the (now-deleted) heal marker could record
    // completion on an empty run, and the caller then re-checked the length to undo
    // it. Both halves of that pair are gone (ISS-5135).
    return;
  }
  const enqueueConfirmed = await enqueueRebuiltSessionsForSync(
    input,
    capturedSourceKey
  );
  // PR #4098 review (shafty023): re-check the generation AFTER the await —
  // `cancelCollectorMaintenance` can have advanced the generation and stopped
  // collectors while the enqueue was awaited. A superseded generation must not
  // inject or nudge queue/network work during stop/restart/close.
  if (!input.shouldContinue()) {
    return;
  }
  if (enqueueConfirmed) {
    // PR #4098 review (wongk): thread the CAPTURED source key through the inject so
    // the sync service refuses the ids unless they still match the live+hydrated
    // identity (an A-enqueued/B-hydrated target flip during the awaited writes must
    // not enter B's lane).
    input.injectSyncBackfillIds?.(input.changedSessionIds, capturedSourceKey);
  }
}

/**
 * The drift-guarded durable-outbox enqueue for the changed session set. Only ever
 * called with a NON-EMPTY set — the caller returns at `changedSessionIds.length
 * === 0` before reaching here (ISS-5135 deleted the empty-run marker that made an
 * online-but-empty `true` meaningful).
 *
 * Resolves `true` only when `enqueueOutboxEntries` resolved for a CONFIRMED
 * online+authenticated path keyed under the CAPTURED source key. `false` on each
 * of the three refusals below: offline/unauthenticated or a legacy source with no
 * outbox delegate, a live-target drift during the awaited rebuild, and a caught
 * write failure.
 *
 * The live inject runs only on `true`. What backstops a `false` depends on which
 * refusal it was, and it is NOT always the outbox:
 *  - Both no-op refusals write nothing by construction.
 *  - The caught write failure may throw before the first chunk lands, so there may
 *    be NO durable rows to hydrate from next boot.
 * Whatever rows the write did land stay durable and hydrate next boot; the ids
 * that never landed rely on the incremental cursor instead — the rebuild bumps
 * each session's `updated_at`, so the `updated_at > watermark` scan re-selects
 * them (see the SYNC INVARIANT in write-core.ts). Skipping the inject on `false`
 * is what keeps an unconfirmed attempt from being mistaken for a delivered one.
 */
async function enqueueRebuiltSessionsForSync(
  input: RunDataRevisionSyncEnqueueInput,
  capturedSourceKey: string | null
): Promise<boolean> {
  const changedSessionIds = input.changedSessionIds;
  // Offline/unauthenticated (captured null) or legacy source without the outbox
  // delegate → no-op, exactly as the sync service's own recordOutboxEnqueue
  // degrades.
  if (!(input.capturedComputeTargetId && capturedSourceKey)) {
    return false;
  }
  const enqueueOutboxEntries = input.enqueueOutboxEntries;
  if (!enqueueOutboxEntries) {
    return false;
  }
  // Re-resolve the LIVE (online-aware) compute target and compare against the
  // captured id: a drift means a target/account switch happened during the awaited
  // rebuild. A drift → no-op (the ids belong to the captured target; enqueuing them
  // under the drifted target would orphan them).
  const liveComputeTargetId = input.resolveLiveComputeTargetId();
  if (liveComputeTargetId !== input.capturedComputeTargetId) {
    input.log(
      `data-revision rebuild: compute target changed during the rebuild (captured ${input.capturedComputeTargetId}, live ${liveComputeTargetId ?? "null"}); skipping enqueue so the captured target retries next boot`
    );
    return false;
  }
  try {
    await Promise.resolve(
      enqueueOutboxEntries(
        capturedSourceKey,
        changedSessionIds.map((externalSessionId) => ({
          externalSessionId,
          syncClass: AgentSessionSyncClass.Backfill,
        }))
      )
    );
    return true;
  } catch (e: unknown) {
    input.log(
      `data-revision rebuild: failed to enqueue ${changedSessionIds.length} changed session(s) for sync: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }
}
