/**
 * @file local-transcript-cloud-sync.ts
 * @description ISS-4647 item 6: derive the session-level
 * {@link TranscriptDisposition} for the desktop LOCAL Sessions list from the
 * local `transcript_sync_state` rows, so the local producer discloses a
 * transcript lane that is still behind instead of reporting a bare `synced`.
 *
 * Before this, the local list derived `cloudSyncState` from `pendingOutboxIds`
 * ALONE. That covers only the metadata lane: once the server acked a session's
 * metadata its id leaves the outbox, so a session whose raw transcript was still
 * queued/uploading read `synced` with no pending disclosure at all — while the
 * cloud list, reading `SessionTranscript`, reported `pending` for the very same
 * session. This module is the local half of that parity.
 *
 * Pure and DB-free on purpose: it maps the narrow
 * {@link TranscriptMainBlobState} projection the store hands back, so it is unit
 * testable without libSQL and safe to import from the main process.
 */
import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSyncStatus } from "../../shared/transcript-sync-status-contract.js";
import {
  type TranscriptMainBlobState,
  transcriptCursorMatchesComputeTarget,
} from "../transcript-sync/transcript-sync-types.js";

/**
 * Map ONE session's local `main` blob state to the same verdict the cloud
 * derives from `SessionTranscript` availability, so both producers feed
 * `reconcileCloudSyncState` the same vocabulary:
 *
 * - readable bytes for the CURRENT compute target (`syncedByteOffset > 0` under
 *   this target's redacted cursor domain) ⇒ `synced`. The cloud calls the same
 *   shape `available`/`stale`; both are "the archived bytes exist", and the cloud
 *   maps `stale` to `synced` too, so a file that uploaded and then grew is NOT a
 *   pending disclosure on either surface.
 * - ISS-4815: a durable cloud `uploaded` ACKNOWLEDGEMENT from the current target
 *   ⇒ `synced` as well, even at a zero cursor. That is exactly the missing-source
 *   case — the desktop never uploaded a byte because the cloud already held a
 *   verified archive — and the stranded recovery reads the same fact to leave the
 *   row settled. Without it the row settles `idle` at zero bytes and this
 *   projection discloses `syncing` forever for a transcript the cloud can read.
 *   Scoped to the acknowledging target for the same reason the cursor is.
 * - `dead` ⇒ `failedPermanent`: the desktop terminally skipped it, the row is as
 *   complete as it will ever be. Matches the cloud's `permanentlyUnavailable`.
 * - `failed` with nothing readable ⇒ `failedTransient`: a retryable attempt
 *   failure the drain re-queues with backoff. The blob is still absent.
 * - anything else with nothing readable (`queued` / `uploading`, or `idle` at
 *   zero bytes) ⇒ `syncing`: expected but not in the cloud yet.
 *
 * A cursor belonging to a PREVIOUS compute target does not count as readable —
 * the same staleness rule the sync lane itself applies (ISS-4647 item 3).
 *
 * `computeTargetId` is REQUIRED, not nullable. Offline there is no target to
 * compare a cursor against, so every row would fall through to `syncing` and the
 * whole list would claim "transcript still uploading" for transcripts that are
 * long since uploaded. That is a worse lie than saying nothing, so the caller
 * skips the lookup entirely while offline (mirroring the pending-outbox lane,
 * which is likewise never read without a target) and no verdict is published.
 */
export function deriveLocalTranscriptDisposition(
  state: TranscriptMainBlobState,
  computeTargetId: string
): TranscriptDisposition {
  if (state.status === TranscriptSyncStatus.Dead) {
    return TranscriptDisposition.FailedPermanent;
  }
  if (
    hasCloudReadableBytes(state, computeTargetId) ||
    hasCurrentTargetCloudAck(state, computeTargetId)
  ) {
    return TranscriptDisposition.Synced;
  }
  if (state.status === TranscriptSyncStatus.Failed) {
    return TranscriptDisposition.FailedTransient;
  }
  return TranscriptDisposition.Syncing;
}

/**
 * Fold a page's `main` blob states into a per-`externalSessionId` verdict map.
 * A session with no row is deliberately ABSENT rather than defaulted to
 * `syncing`: the local surface covers harnesses the archive lane does not sync
 * at all and installs where the lane is off, so "no row" means "no verdict" and
 * the list must not fabricate a pending disclosure. (The CLOUD list synthesizes
 * `syncing` for a zero-row session because every cloud session is known to
 * expect a `main` file; that premise does not hold locally.)
 */
export function buildLocalTranscriptDispositions(
  states: TranscriptMainBlobState[],
  computeTargetId: string
): Map<string, TranscriptDisposition> {
  const byId = new Map<string, TranscriptDisposition>();
  for (const state of states) {
    byId.set(
      state.externalSessionId,
      deriveLocalTranscriptDisposition(state, computeTargetId)
    );
  }
  return byId;
}

/**
 * ISS-4647: fold the two local cloud-sync lanes into the wire fields the shared
 * Sessions table reads.
 *
 * `cloudSyncState` runs the transcript verdict through the SAME
 * `reconcileCloudSyncState` the cloud projection uses (which is why that helper
 * lives in `@repo/api`), then ORs in the metadata-lane outbox — a row not yet
 * acked by the server is `pending` regardless of what its blob lane says.
 *
 * `transcriptDisposition` is reported ONLY when the metadata lane is caught up.
 * That is deliberate and is what lets the disclosure badge name the right gap
 * (ISS-4647 item 7): when the outbox is still pending the session is not in the
 * cloud AT ALL, so the blob verdict is subsumed by the stronger "local only"
 * statement, and publishing it would let the UI narrow the message to "just the
 * transcript" when the whole row is missing.
 *
 * #4150 (shafty023 review): a FAILED lookup is not proof the session is synced.
 * The loaders distinguish an *unavailable* lane (a lookup that was attempted and
 * threw — {@link TranscriptDispositionLookup} `available:false` / `outboxKnown`
 * false) from a *proven-empty* one (offline/no-delegate — never consulted — or a
 * successful read that found nothing). When a lane is unavailable we cannot prove
 * the row is caught up, so we OMIT the disclosure entirely (leave `cloudSyncState`
 * undefined, which the consumers already treat as "unknown — render nothing")
 * rather than stamping a false `synced`:
 *
 * - `outboxKnown` false ⇒ the outbox read failed, so we cannot prove the metadata
 *   lane is server-acked. Omit the whole disclosure (and never publish a
 *   transcript verdict that would claim the row is already in the cloud).
 * - outbox proven absent but `transcriptAvailable` false ⇒ metadata is caught up
 *   but the blob lane is unknown, so we cannot prove the aggregate is `synced`.
 *   Omit the disclosure rather than defaulting `synced`.
 *
 * The never-consulted paths (offline `computeTargetId`, a source with no
 * `loadPendingOutboxIds`/`loadTranscriptBlobStates` delegate, and the by-id/detail
 * reads that pass no sets) stay `outboxKnown:true` / `transcriptAvailable:true`
 * with an empty result, preserving the honest `synced` default they relied on.
 */
export function buildLocalCloudSyncDisclosure(
  outbox: OutboxDisclosureInput,
  transcript: TranscriptDisclosureInput
): {
  cloudSyncState?: AgentSessionCloudSyncState;
  transcriptDisposition?: TranscriptDisposition;
} {
  if (!outbox.known) {
    // The outbox read failed: metadata-lane state is unknown, so nothing can
    // truthfully claim this row is caught up. Publish no disclosure.
    return {};
  }
  if (outbox.pending) {
    return { cloudSyncState: AgentSessionCloudSyncState.Pending };
  }
  if (!transcript.available) {
    // Metadata is proven acked, but the blob lookup failed — the aggregate could
    // still be `pending` on a transcript we could not read. Omit rather than lie.
    return {};
  }
  return {
    cloudSyncState: reconcileCloudSyncState(transcript.disposition),
    ...(transcript.disposition
      ? { transcriptDisposition: transcript.disposition }
      : {}),
  };
}

/** True when this compute target's cloud already holds readable archive bytes. */
function hasCloudReadableBytes(
  state: TranscriptMainBlobState,
  computeTargetId: string
): boolean {
  if (state.syncedByteOffset <= 0) {
    return false;
  }
  return transcriptCursorMatchesComputeTarget(
    state.syncedComputeTargetId,
    computeTargetId
  );
}

/**
 * ISS-4815: did the CURRENT compute target's cloud authoritatively acknowledge
 * that it already holds this transcript?
 *
 * An acknowledgement with no attributed target is NOT accepted here: the
 * stranded recovery deliberately re-arms that row (it errs toward re-uploading),
 * so accepting it would publish `synced` for a file the lane is about to try to
 * send. The two must agree, and the disclosure is the side that has to stay
 * conservative.
 */
function hasCurrentTargetCloudAck(
  state: TranscriptMainBlobState,
  computeTargetId: string
): boolean {
  return (
    state.cloudUploadedAt !== null &&
    state.cloudUploadedComputeTargetId === computeTargetId
  );
}

export const EMPTY_TRANSCRIPT_DISPOSITIONS: ReadonlyMap<
  string,
  TranscriptDisposition
> = new Map<string, TranscriptDisposition>();

/** The bounded, page-scoped `main` blob-state lookup the caller injects. */
export type LoadTranscriptBlobStates = (
  externalSessionIds: string[]
) => Promise<TranscriptMainBlobState[]>;

/**
 * #4150: the outcome of the page's transcript-blob lookup, discriminated so a
 * FAILED read is not confused with a proven-empty one.
 *
 * - `available: true` — the lane was either never consulted (offline / no
 *   delegate / empty page — an honest "nothing to disclose") or read
 *   successfully. `byId` carries the per-session verdicts (empty when not
 *   consulted). The caller may safely default absent rows to `synced`.
 * - `available: false` — a lookup was attempted and THREW. The blob lane's state
 *   is unknown for the whole page, so the caller must omit the disclosure rather
 *   than defaulting `synced` (which would recreate the false state ISS-4647
 *   fixes).
 */
export type TranscriptDispositionLookup =
  | { available: true; byId: ReadonlyMap<string, TranscriptDisposition> }
  | { available: false };

/**
 * #4150: per-lane inputs {@link buildLocalCloudSyncDisclosure} folds. Split from
 * the raw `(boolean, disposition)` pair so a failed lookup (`known` / `available`
 * false) is distinguishable from a proven-not-pending / no-verdict result.
 */
export type OutboxDisclosureInput =
  | { known: true; pending: boolean }
  | { known: false };
export type TranscriptDisclosureInput =
  | { available: true; disposition: TranscriptDisposition | undefined }
  | { available: false };

/**
 * ISS-4647: resolve the page's transcript-blob verdicts. Best-effort and never
 * throwing into the list read — no resolver or an empty page yields an
 * `available` result with an empty map (the lane was never consulted), which
 * degrades the row to the outbox-only disclosure rather than breaking the list or
 * fabricating a "pending".
 *
 * #4150 (shafty023 review): a lookup FAILURE is NOT the same as a successful
 * empty read. The `catch` returns `{ available: false }` so the caller preserves
 * the row as unknown and omits the disclosure, instead of stamping an
 * outbox-acked row `synced` on the strength of a read that never completed.
 *
 * A null `computeTargetId` (offline/unauthenticated) skips the lookup for the
 * same reason the pending-outbox lane does: with no target, no cursor can be
 * proven current, so every row would fall through to `syncing` and the list would
 * claim "transcript still uploading" for transcripts uploaded long ago. Saying
 * nothing is the honest answer there — and it is a never-consulted skip, not a
 * failure, so it stays `available: true` with an empty map.
 *
 * #4150: extracted here from `shared-agent-sessions-api.ts` (a grandfathered
 * over-ceiling file) — this cohesive transcript-lane lookup belongs with the rest
 * of the local transcript-disposition derivation, not in the sessions-API
 * monolith. Takes the two fields it needs rather than the whole options object,
 * so the sibling stays free of a back-import of `GetSharedAgentSessionsOptions`.
 */
export async function loadLocalTranscriptDispositions(
  computeTargetId: string | null,
  loadTranscriptBlobStates: LoadTranscriptBlobStates | undefined,
  externalSessionIds: string[]
): Promise<TranscriptDispositionLookup> {
  if (
    !(computeTargetId && loadTranscriptBlobStates) ||
    externalSessionIds.length === 0
  ) {
    return { available: true, byId: EMPTY_TRANSCRIPT_DISPOSITIONS };
  }
  try {
    const states = await loadTranscriptBlobStates(externalSessionIds);
    return {
      available: true,
      byId: buildLocalTranscriptDispositions(states, computeTargetId),
    };
  } catch {
    return { available: false };
  }
}
