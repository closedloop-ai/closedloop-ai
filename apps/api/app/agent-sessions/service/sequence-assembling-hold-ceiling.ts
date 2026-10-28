/**
 * ISS-11427: the WALL-CLOCK CEILING on the ISS-8131 `sequence_assembling` hold.
 *
 * `resolveSessionSliceGate` holds a revision-less payload that arrives while a
 * chunk sequence is staged: nothing is written and the id is withheld from
 * `acceptedSessionIds`, so the desktop re-sends it. The hold cleared only when
 * that precondition did — the staged sequence committing, a re-send carrying a
 * real revision, or the 72-hour `pending-chunk-sweep-service.ts` cron freeing
 * the marker. The desktop's side is bounded far tighter: roughly 45 minutes of
 * `ack_omitted` retries before the row dead-letters
 * (`monitored-activity-hold-ceiling.ts` carries the derivation). A precondition
 * slower than that was paid for in the session's data.
 *
 * At the ceiling the slice frees the staged marker in-line, exactly as the
 * sweep would, and lets the payload apply. That does not reintroduce the
 * ISS-8131 defect, which was the staged sequence's tail later acking and
 * SEALING the union of two derivations as one authoritative `dataRevision`.
 * With the marker gone there is no sequence left for a tail to seal: a later
 * chunk of it is foreign (`resolveChunkGating`), and the next chunk 0 opens a
 * fresh sequence and replaces the children. That includes a chunk 0 AT the
 * committed revision, which ISS-6167 otherwise re-opens without a delete: the
 * freed patch sets `dataRevisionDiverged`, because the payload it admits lands
 * on top of children the revision no longer describes (#8395 review, whitlockk).
 *
 * ## What the ceiling is measured FROM
 *
 * `lastSyncedAt`, the staged sequence's last write. Every chunk stamps it and a
 * held payload writes nothing, so a sequence still receiving chunks is never
 * freed, and one that has received nothing for the ceiling is.
 *
 * It is NOT the hold's own first delivery. The server cannot see how much of
 * the desktop's budget is left, and the two errors are not symmetric. Freeing a
 * row-level marker early costs its producer the unsent tail (dropped and
 * re-prepared from chunk 0 by `abandonUnpersistedChunkTail` in
 * `apps/desktop/src/main/agent-sync/agent-session-sync-accepted-ack.ts`) and
 * one strike against its bounded `ack_omitted` budget, but no data. Holding
 * past that budget costs the session. Measuring from the hold's start, which is
 * never earlier than `lastSyncedAt`, only ever frees later.
 *
 * Known limit: a budget already part-spent BEFORE the sequence's last write,
 * by an open monitored-activity hold on the same session, is not counted here.
 * `monitoredActivityHeldSince` cannot be folded into the anchor: it is not
 * cleared by chunk progress, so it would free a sequence that is still
 * receiving chunks (both found in review of this change).
 *
 * ## What it declines
 *
 * A marker whose producer band is not `PendingChunkAckContract.RowLevel` is
 * never freed here, on the same data-loss grounds the sweep declines it
 * (`orphanedChunkMarkerWhere`): a producer that did not ask for the echo reads
 * a no-echo 200 as acking its tail and deletes it.
 */
import {
  type ChunkGatingDecision,
  type ChunkGatingInput,
  resolveChunkGating,
} from "./chunk-revision-gating";
import { MONITORED_ACTIVITY_HOLD_CEILING_MS } from "./monitored-activity-hold-ceiling";
import { PendingChunkAckContract } from "./pending-chunk-ack-contract";

/**
 * The monitored-activity hold's ceiling, shared rather than restated: both are
 * sized to resolve inside the same desktop `ack_omitted` horizon.
 */
export const SEQUENCE_ASSEMBLING_HOLD_CEILING_MS =
  MONITORED_ACTIVITY_HOLD_CEILING_MS;

/** The stored row fields the ceiling reads. */
export type SequenceAssemblingHoldRow = Readonly<{
  lastSyncedAt: Date;
  pendingChunkAckContract: string | null;
}>;

/**
 * The marker columns a freed sequence writes: all four together, because
 * `schema.prisma` states they are all NULL when no sequence is mid-apply.
 * `pendingChunkAckContract` is cleared by `resolvePendingChunkAckContractPatch`
 * off the NULL revision here, so it is not repeated.
 */
export const FREED_PENDING_CHUNK_MARKER = {
  pendingChunkRevision: null,
  pendingChunkTotal: null,
  pendingChunkReceived: null,
} as const;

/**
 * The chunk gate's decision with the ceiling applied: unchanged unless this
 * payload would be held as `sequence_assembling` and the hold has expired, in
 * which case it is the decision for the same payload against NO staged
 * sequence, plus the patch that frees the stored marker.
 *
 * `holdable` is the caller's statement that the hold is expressible at all —
 * the batch asked for the row-level ack — so a hold the gate would never issue
 * is never expired here.
 */
export function resolveChunkGatingUnderHoldCeiling(
  chunkInput: ChunkGatingInput,
  hold: Readonly<{
    holdable: boolean;
    receivedAt: Date;
    row: SequenceAssemblingHoldRow | null;
  }>
): { decision: ChunkGatingDecision; holdExpired: boolean } {
  const decision = resolveChunkGating(chunkInput);
  if (
    !(
      decision.revisionlessMidSequence &&
      hold.holdable &&
      hold.row &&
      isSequenceAssemblingHoldExpired(hold.row, hold.receivedAt)
    )
  ) {
    return { decision, holdExpired: false };
  }
  const released = resolveChunkGating({
    ...chunkInput,
    existingPendingRevision: null,
    existingPendingTotal: null,
    existingPendingReceived: null,
  });
  return {
    decision: {
      ...released,
      pendingChunkPatch: {
        ...released.pendingChunkPatch,
        ...FREED_PENDING_CHUNK_MARKER,
        // The payload lands additively on whatever the staged sequence left,
        // so the children no longer equal the committed revision; the next
        // payload at that revision replaces them (`repairsDivergedRevision`).
        dataRevisionDiverged: true,
      },
    },
    holdExpired: true,
  };
}

export function isSequenceAssemblingHoldExpired(
  row: SequenceAssemblingHoldRow,
  receivedAt: Date
): boolean {
  if (row.pendingChunkAckContract !== PendingChunkAckContract.RowLevel) {
    return false;
  }
  return (
    receivedAt.getTime() - row.lastSyncedAt.getTime() >=
    SEQUENCE_ASSEMBLING_HOLD_CEILING_MS
  );
}
