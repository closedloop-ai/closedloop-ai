import { AgentSessionCloudSyncState } from "./agent-session-cloud-sync-state-constants.ts";
import { TranscriptDisposition } from "./transcript-disposition-constants.ts";

/**
 * ISS-4647: the cloud-sync reconciliation gate, moved out of
 * `apps/api/app/agent-sessions/transcript-availability.ts` so BOTH producers of
 * `AgentSessionListItem.cloudSyncState` share one implementation. The cloud
 * list/detail projection lives in `apps/api`; the desktop LOCAL Sessions
 * producer lives in `apps/desktop` and cannot import it, so leaving the rule in
 * `apps/api` guaranteed the two surfaces would drift (they did — the local list
 * derived `cloudSyncState` from the outbox alone and reported `synced` while the
 * raw transcript was still queued). Pure over two contract enums that already
 * live here, so it belongs in `packages/api/src/types` per the canonical
 * type-placement rule.
 */

/**
 * ISS-4621: reconcile the per-row cloud-sync disclosure ({@link
 * AgentSessionCloudSyncState}) with the transcript-BLOB lane so `synced` cannot
 * lie while a required transcript file is still uploading.
 *
 * The two cloud lanes are INDEPENDENT: the derived-data lane (turns/events/tool
 * usage — synced at metadata upsert) and the raw-transcript-blob lane (the
 * separate `TranscriptSyncService` upload, surfaced as
 * {@link TranscriptDisposition}). The cloud list/detail projection previously
 * stamped `cloudSyncState: synced` on EVERY cloud row on the theory that "the row
 * exists in the cloud DB", which ignored the blob lane entirely — so a session
 * with full derived data but a `main` transcript still `missing`/`uploadPending`
 * (SES-78221: 35 turns, 521 tool calls, blob never uploaded) reported `synced`
 * while its transcript sat in limbo. This gate makes the aggregate truthful:
 *
 * - `syncing` (the blob is `missing`/`uploadPending` — expected but NOT yet in
 *   the cloud) OR `failedTransient` (a retryable upload FAILURE the desktop
 *   re-queues with backoff — the blob is still absent and still coming) ⇒ the
 *   cloud copy IS behind, so the row is NOT `synced`. Both map to `pending`,
 *   exactly the "still uploading to the cloud, cloud copy may be behind"
 *   disclosure the existing `CloudSyncStateBadge` renders — honest, and no new UI
 *   vocabulary needed. Treating an in-flight retry as settled would reintroduce
 *   the exact false `synced` this ticket set out to kill, just on the retry path.
 * - `synced` / `stale` / `failedPermanent` / `neverExpected`
 *   ⇒ `synced`: the blob lane is either caught up (`stale` is still readable —
 *   archived bytes exist), terminally settled (`failedPermanent` — the transcript
 *   is never coming, the row is as complete as it will ever be, and the
 *   `transcriptDisposition` field carries the honest failure detail), or the
 *   session legitimately expects no transcript. None of these is an in-flight
 *   "cloud copy is behind" state, so the row is truthfully `synced`.
 * - An absent/undefined disposition (a producer that did not compute the verdict)
 *   ⇒ `synced`, the prior default: without a blob-lane verdict there is nothing
 *   to contradict the derived-data lane, so we do not fabricate `pending`.
 *
 * An exhaustive switch keeps this honest: adding a `TranscriptDisposition`
 * variant fails typecheck here until it is intentionally classified.
 */
export function reconcileCloudSyncState(
  transcriptDisposition: TranscriptDisposition | undefined
): AgentSessionCloudSyncState {
  if (transcriptDisposition === undefined) {
    return AgentSessionCloudSyncState.Synced;
  }
  return isTranscriptBlobBehind(transcriptDisposition)
    ? AgentSessionCloudSyncState.Pending
    : AgentSessionCloudSyncState.Synced;
}

/**
 * ISS-4647: whether a transcript verdict means the blob is STILL COMING — the
 * blob is missing/in-flight (`syncing`), or a retryable attempt failed and the
 * desktop will re-queue it with backoff (`failedTransient`). Either way the blob
 * is absent from the cloud and the cloud copy is genuinely behind.
 *
 * Every other verdict is settled: the blob is caught up (`synced`), readable but
 * possibly behind (`stale` — archived bytes exist), terminally never coming
 * (`failedPermanent`, whose honest detail rides `transcriptDisposition` itself),
 * or legitimately never expected (`neverExpected`).
 *
 * Exported because this predicate — not `cloudSyncState` — is what a UI needs to
 * decide whether the transcript is the gap it should NAME. The badge that
 * discloses "Transcript syncing" vs "Local only" reads it here rather than
 * re-declaring the in-flight set, so the two can never disagree about which
 * dispositions mean "still uploading".
 *
 * An exhaustive switch keeps this honest: adding a `TranscriptDisposition`
 * variant fails typecheck here until it is intentionally classified. Version-skew
 * safety: an unknown/legacy disposition string a newer producer might emit
 * degrades to "settled" rather than crashing — it must never make a row LIE as
 * still-uploading, and it never widens the no-verdict default.
 */
export function isTranscriptBlobBehind(
  transcriptDisposition: TranscriptDisposition
): boolean {
  switch (transcriptDisposition) {
    case TranscriptDisposition.Syncing:
    case TranscriptDisposition.FailedTransient:
      return true;
    case TranscriptDisposition.Synced:
    case TranscriptDisposition.Stale:
    case TranscriptDisposition.FailedPermanent:
    case TranscriptDisposition.NeverExpected:
      return false;
    default: {
      // The `never` binding proves every KNOWN member above is handled; the
      // runtime guard exists only for wire-unknown values.
      const _exhaustive: never = transcriptDisposition;
      return false;
    }
  }
}
