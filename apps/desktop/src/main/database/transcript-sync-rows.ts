/**
 * @file transcript-sync-rows.ts
 * @description The `TranscriptSyncState` columns the fingerprint path reads —
 * a PROJECTION of the persisted row, not the whole of it (ISS-6326) — and the
 * pure functions over it: the BigInt coercion the writer needs, the row → domain
 * {@link TranscriptFingerprint} mapper, and the pincer interleave that builds a
 * ready batch out of two row orderings.
 *
 * Separate from `transcript-sync-store.ts` because everything here is pure and
 * typed in terms of the PERSISTED row: no {@link DesktopPrisma} handle, no
 * queries, no db-host boundary. The boundary is deliberate — a helper that
 * takes a domain `TranscriptFingerprint` rather than a `TranscriptRow` (the
 * observation policy) stays with the store.
 */

import {
  asTranscriptSyncClass,
  asTranscriptSyncStatus,
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../../shared/transcript-sync-status-contract.js";
import {
  type TranscriptFingerprint,
  transcriptQueueKey,
} from "../transcript-sync/transcript-sync-types.js";

/**
 * ISS-6326: the `TranscriptSyncState` columns the fingerprint path reads, and
 * ONLY those. Not the whole persisted row: `createdAt`/`updatedAt` are never
 * mapped, and `cloudUploadedAt`/`cloudUploadedComputeTargetId` belong to the
 * `listMainBlobStates` projection, which carries its own `select` and its own
 * return type rather than passing through {@link toFingerprint}.
 */
export type TranscriptRow = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: string;
  sourcePath: string;
  sourcePathHash: string;
  lastMtimeMs: bigint | null;
  lastSize: bigint | null;
  syncedByteOffset: bigint;
  syncedSha256: string | null;
  storedEtag: string | null;
  syncedComputeTargetId: string | null;
  status: string;
  syncClass: string;
  retryCount: number;
  missingSourceCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  laneStalledSince: string | null;
};

/**
 * The `select` every read feeding {@link toFingerprint} passes, so the query
 * asks for exactly what the mapper consumes.
 *
 * The `satisfies` is the guard that matters: widening a `select` never fails
 * `tsc` on its own, so without it a column could be added back here — or a new
 * {@link TranscriptRow} field left unselected — and nothing would complain until
 * production handed the mapper an `undefined`. Both directions are checked:
 * excess-property checking rejects a key that is not on `TranscriptRow`, and the
 * `Record` rejects a `TranscriptRow` key that is missing.
 */
export const TRANSCRIPT_FINGERPRINT_SELECT = {
  externalSessionId: true,
  fileKey: true,
  sourceHarness: true,
  sourcePath: true,
  sourcePathHash: true,
  lastMtimeMs: true,
  lastSize: true,
  syncedByteOffset: true,
  syncedSha256: true,
  storedEtag: true,
  syncedComputeTargetId: true,
  status: true,
  syncClass: true,
  retryCount: true,
  missingSourceCount: true,
  nextAttemptAt: true,
  lastError: true,
  // ISS-7097: read by the drain's lane-wide ceiling. `uploadingSince` is
  // deliberately NOT here — only the reclaim's own `updateMany` predicate reads
  // the lease, so adding it would widen this projection (ISS-6326) for nothing.
  laneStalledSince: true,
} as const satisfies Record<keyof TranscriptRow, true>;

export function toBigInt(value: number | null): bigint | null {
  return value == null ? null : BigInt(Math.trunc(value));
}

/**
 * Interleave newest-first and oldest-first backfill rows into a single "pincer"
 * ready batch: newest, oldest, 2nd-newest, 2nd-oldest, … deduped by identity
 * (the two orderings overlap when few rows are ready). This guarantees the
 * OLDEST queued file lands in the second slot of every drain batch, so a large
 * historical tail drains monotonically from both ends and can never be starved
 * by a steady stream of newer transcripts arriving at the head. The
 * newest-first bias in slot 0 preserves the recent-first freshness intent
 * (PLN-1288) for the rest of the batch. `newest`/`oldest` are the same backfill
 * rows queried in opposite `lastMtimeMs` order; each pointer advances every
 * iteration, so the loop always terminates.
 */
export function interleaveBackfillReady(
  newest: TranscriptRow[],
  oldest: TranscriptRow[],
  limit: number
): TranscriptRow[] {
  const result: TranscriptRow[] = [];
  const seen = new Set<string>();
  let newestIdx = 0;
  let oldestIdx = 0;
  // Start on the newest side so slot 0 stays freshness-biased; the oldest side
  // then always occupies slot 1 whenever the tail is non-empty.
  let takeOldest = false;
  while (
    result.length < limit &&
    (newestIdx < newest.length || oldestIdx < oldest.length)
  ) {
    const row = takeOldest ? oldest[oldestIdx++] : newest[newestIdx++];
    takeOldest = !takeOldest;
    if (!row) {
      continue;
    }
    const key = transcriptQueueKey(row.externalSessionId, row.fileKey);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

export function toFingerprint(row: TranscriptRow): TranscriptFingerprint {
  return {
    externalSessionId: row.externalSessionId,
    fileKey: row.fileKey,
    sourceHarness: row.sourceHarness,
    sourcePath: row.sourcePath,
    sourcePathHash: row.sourcePathHash,
    lastMtimeMs: row.lastMtimeMs == null ? null : Number(row.lastMtimeMs),
    lastSize: row.lastSize == null ? null : Number(row.lastSize),
    syncedByteOffset: Number(row.syncedByteOffset),
    syncedSha256: row.syncedSha256,
    storedEtag: row.storedEtag,
    syncedComputeTargetId: row.syncedComputeTargetId,
    // `status`/`sync_class` are unconstrained TEXT columns; validate against the
    // known member set rather than trusting an unchecked cast, falling back to a
    // safe terminal/lowest-priority state if the row ever holds an unknown value.
    status: asTranscriptSyncStatus(row.status) ?? TranscriptSyncStatus.Idle,
    syncClass:
      asTranscriptSyncClass(row.syncClass) ?? TranscriptSyncClass.Backfill,
    retryCount: row.retryCount,
    missingSourceCount: row.missingSourceCount,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    laneStalledSince: row.laneStalledSince,
  };
}
