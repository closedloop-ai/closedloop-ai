/**
 * @file pending-chunk-ack-contract.ts
 * @description ISS-8602 — which acknowledgement contract the producer that
 * OPENED a staged chunk sequence speaks, recorded on the row beside the marker
 * itself.
 *
 * WHY THE COLUMN EXISTS. The TTL sweep in `pending-chunk-sweep-service.ts` runs
 * on a cron with no request in hand, so it cannot ask the producer anything.
 * `wantsAcceptedSessionIds` is a PER-REQUEST flag — `upsert-sessions-batch.ts`
 * reads it off the payload and fans it out as `rowLevelAck` — and it was never
 * persisted, so nothing downstream of the request could tell the two producer
 * bands apart.
 *
 * WHY THE SWEEP HAS TO. A build that does not request the echo is answered
 * `{accepted: true}` with no per-session list, and `splitAckedIds`
 * (`apps/desktop/src/main/agent-sync/agent-session-sync-accepted-ack.ts`) reads
 * that as the legacy whole-batch contract: every id it sent is acked and its
 * outbox row is DELETED. So for that band the cost of a freed marker is not a
 * re-send — a chunk delivered afterwards lands foreign, is written nowhere, and
 * is dropped from the only place it still existed. The reviewer finding this
 * closes (davetho, P1 on #7092) is data loss on installed clients that cannot
 * be redeployed, so the sweep declines those rows by construction rather than
 * waiting on a fleet upgrade.
 *
 * WHY IT IS STAGED WITH THE MARKER AND NOT LOOKED UP LATER. The band belongs to
 * the sequence, not to the session or the device: the producer that opened this
 * sequence is the one whose outbox holds its tail. Deriving it from the marker
 * patch keeps the two in step: the band is written exactly when
 * `pendingChunkRevision` is, cleared exactly when it is cleared, and left alone
 * otherwise.
 *
 * TWO WRITERS, not one, and both must call this. The shared gate's patch is
 * spread by `session-slice-detail-write.ts`; the ISS-8604 create arm re-runs
 * `resolveChunkGating` with every stored field forced absent and NAMES its
 * columns instead, so it can stage a marker the shared gate refused — a stale
 * chunk 0 is foreign against the stored row and advancing against no row. That
 * arm therefore resolves the band through this same function
 * (`upsert-arm-detail.ts`, `resolveCreateArmChunkColumns`) rather than
 * inheriting an empty patch, which would have landed a staged marker with a NULL
 * band: declined by the sweep forever, for a reason with nothing to do with its
 * producer, and indistinguishable from a pre-migration row in the count
 * (review: review-soul).
 *
 * UNKNOWN MEANS DO-NOT-CLEAR, and the fail-safe is SQL's, not a branch's. The
 * sweep selects on `= RowLevel`, which no NULL and no unrecognized value can
 * satisfy under three-valued logic. So every row written before this column
 * existed — and every future band this build cannot name — is outside the
 * sweep's reach without anyone having to remember to exclude it. That is what
 * makes the hazard closed from the first deploy and across a partially-migrated
 * fleet, rather than after a backfill.
 */

import type { PendingChunkPatch } from "./chunk-revision-gating";

/**
 * The acknowledgement contract a producer speaks, as stored.
 *
 * Stored as text rather than a boolean so an unrecognized future value is
 * REPRESENTABLE: the sweep's equality test then declines it on the safe side and
 * the skipped counter still sees it, where a boolean would have forced a third
 * band into one of these two spellings.
 */
export const PendingChunkAckContract = {
  /**
   * The producer asked for `acceptedSessionIds` (post-#4862). Withholding an id
   * from the echo is a signal it understands, so a freed marker costs it a
   * re-send and nothing more. The ONLY band this sweep may clear.
   */
  RowLevel: "row_level",
  /**
   * The producer did not ask. It reads any 200 as acking every id in the batch,
   * so it has already deleted its outbox rows and a freed marker can cost it the
   * tail.
   */
  WholeBatch: "whole_batch",
} as const;
export type PendingChunkAckContract =
  (typeof PendingChunkAckContract)[keyof typeof PendingChunkAckContract];

/** The ack-contract column to write alongside a pending-chunk marker patch. */
export type PendingChunkAckContractPatch = {
  pendingChunkAckContract?: PendingChunkAckContract | null;
};

/**
 * Resolve the ack-contract column from the marker patch this same apply is
 * writing, so the two columns move together or not at all.
 *
 * It keys off the PRESENCE of `pendingChunkRevision` in the patch rather than
 * re-deriving the gate's decision, which is what makes drift impossible: chunk 0
 * stages the revision and so stamps the band; the committing apply nulls the
 * revision and so nulls the band; an interior chunk's patch carries only
 * `pendingChunkReceived`, leaving both alone — the band stays the one chunk 0
 * recorded, which is the producer whose outbox holds the tail.
 */
export function resolvePendingChunkAckContractPatch(
  pendingChunkPatch: PendingChunkPatch,
  rowLevelAck: boolean
): PendingChunkAckContractPatch {
  if (!("pendingChunkRevision" in pendingChunkPatch)) {
    return {};
  }
  if (pendingChunkPatch.pendingChunkRevision == null) {
    return { pendingChunkAckContract: null };
  }
  return {
    pendingChunkAckContract: rowLevelAck
      ? PendingChunkAckContract.RowLevel
      : PendingChunkAckContract.WholeBatch,
  };
}
