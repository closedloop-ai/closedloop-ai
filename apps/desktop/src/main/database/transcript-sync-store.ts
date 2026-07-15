/**
 * @file transcript-sync-store.ts
 * @description Durable per-transcript-file fingerprint + upload-cursor store for
 * the archive lane (FEA-2715). Mirrors `createSqliteSessionSyncSource`: a thin
 * factory over {@link DesktopPrisma} whose methods take/return only
 * structure-clone-safe plain data, so they can be exposed on the runtime
 * `SqliteAgentDatabase` and invoked from the main process across the db-host
 * IPC boundary (FEA-2038) — writes never cross the boundary, they run in the
 * db-host child via `prisma.write`.
 *
 * The `TranscriptSyncState` row is a cache/queue only; server state from
 * `sync-plan` is authoritative (recovery invariant 2), so losing rows is
 * harmless. BigInt columns (byte offsets/sizes, mtime ms) are surfaced as
 * `number` — local transcript sizes are far below 2^53.
 */

import {
  asTranscriptSyncClass,
  asTranscriptSyncStatus,
  type TranscriptFingerprint,
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../transcript-sync/transcript-sync-types.js";
import type { DesktopPrisma } from "./prisma-client.js";

type TranscriptRow = {
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
  nextAttemptAt: string | null;
  lastError: string | null;
};

/** A file observed by discovery/hook, with cheap fingerprint fields. */
export type TranscriptObserveInput = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: string;
  sourcePath: string;
  sourcePathHash: string;
  mtimeMs: number | null;
  size: number | null;
  syncClass: TranscriptSyncClass;
  /**
   * The live compute target id when known (online), else null/undefined. A file
   * whose cached cursor belongs to a different target is re-queued so it
   * re-uploads to the newly selected target (the old cursor points at the old
   * target's S3 object).
   */
  currentComputeTargetId?: string | null;
  now: string;
};

/** Server-verified state to persist after a successful `complete`. */
export type TranscriptUploadedInput = {
  externalSessionId: string;
  fileKey: string;
  syncedByteOffset: number;
  syncedSha256: string | null;
  storedEtag: string | null;
  syncedComputeTargetId: string | null;
  /** True when the synced window reached the file's current end. */
  caughtUp: boolean;
  now: string;
};

/** Failure bookkeeping for the backoff / dead-letter policy. */
export type TranscriptFailureInput = {
  externalSessionId: string;
  fileKey: string;
  retryCount: number;
  dead: boolean;
  nextAttemptAt: string | null;
  lastError: string;
  now: string;
};

export type TranscriptSyncStore = {
  get(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptFingerprint | null>;
  listAll(): Promise<TranscriptFingerprint[]>;
  listReady(now: string, limit: number): Promise<TranscriptFingerprint[]>;
  observe(input: TranscriptObserveInput): Promise<TranscriptFingerprint>;
  markUploading(
    externalSessionId: string,
    fileKey: string,
    now: string
  ): Promise<void>;
  /** Settle a file with no actionable work (missing / no complete line yet). */
  markIdle(
    externalSessionId: string,
    fileKey: string,
    now: string
  ): Promise<void>;
  recordUploaded(input: TranscriptUploadedInput): Promise<void>;
  recordFailure(input: TranscriptFailureInput): Promise<void>;
  /**
   * Boot recovery: reset rows left in `uploading` by a crash/force-quit back to
   * `queued`. Safe on start because no upload is in flight in a fresh process,
   * and `listReady`/`planObservation` would otherwise never re-pick them.
   * Returns the number of rows revived.
   */
  requeueStale(now: string): Promise<number>;
};

function toBigInt(value: number | null): bigint | null {
  return value == null ? null : BigInt(Math.trunc(value));
}

function toFingerprint(row: TranscriptRow): TranscriptFingerprint {
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
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  };
}

type PlannedObservation = Pick<
  TranscriptFingerprint,
  "status" | "syncClass" | "retryCount" | "nextAttemptAt" | "lastError"
> & {
  /**
   * Whether to persist the freshly observed mtime/size/path onto the row. Only
   * true when this observation is acted on (`needsSync`): advancing these while
   * a row is `uploading` (or otherwise not re-queued) would consume the growth
   * signal — a file that grows mid-upload would look "unchanged" once the
   * in-flight upload settles to `idle`, and its trailing bytes would never
   * re-queue (permanent loss of the appended lines).
   */
  advanceObserved: boolean;
};

/**
 * Decide the row's next status/class/retry from a fresh observation. A file is
 * (re)queued only when it is new or actually changed — mtime/size/path differs,
 * or the compute target switched (the cached cursor belonged to the old
 * target). Change detection alone drives re-sync: multi-window continuation is
 * carried by `recordUploaded` leaving the row `queued`, so an unchanged,
 * already-synced file (including one whose partial trailing line is not on a
 * newline boundary) settles to `idle` and never flaps back to `queued`. An
 * in-flight (`uploading`) row is never disturbed; a dead-lettered row re-queues
 * only on a real change (one more chance for a grown file), and a changed/new
 * file resets the backoff.
 */
function planObservation(
  existing: TranscriptFingerprint | null,
  input: TranscriptObserveInput
): PlannedObservation {
  const targetSwitched =
    input.currentComputeTargetId != null &&
    existing?.syncedComputeTargetId != null &&
    existing.syncedComputeTargetId !== input.currentComputeTargetId;
  // `fs.stat` reports a fractional `mtimeMs` (sub-ms precision on APFS/ext4),
  // but the stored `lastMtimeMs` was truncated to an integer via `toBigInt`
  // (`BigInt(Math.trunc(...))`). Truncate the observed mtime to the same
  // precision before comparing (preserving `null`), otherwise `changed` is
  // always true and every sweep re-queues every file (FEA-2834).
  const observedMtimeMs =
    input.mtimeMs == null ? null : Math.trunc(input.mtimeMs);
  const changed =
    !existing ||
    targetSwitched ||
    existing.lastMtimeMs !== observedMtimeMs ||
    existing.lastSize !== input.size ||
    existing.sourcePath !== input.sourcePath;

  // `uploading` is left alone (an upload is in flight); every other status
  // re-queues iff the file changed. When `changed` is false the row keeps its
  // current status, so a `dead` row stays dead until the file actually grows.
  const needsSync =
    changed && existing?.status !== TranscriptSyncStatus.Uploading;
  const resetBackoff = needsSync;
  const syncClass: TranscriptSyncClass =
    input.syncClass === TranscriptSyncClass.Live
      ? TranscriptSyncClass.Live
      : (existing?.syncClass ?? TranscriptSyncClass.Backfill);

  return {
    status: needsSync
      ? TranscriptSyncStatus.Queued
      : (existing?.status ?? TranscriptSyncStatus.Idle),
    syncClass,
    retryCount: resetBackoff ? 0 : (existing?.retryCount ?? 0),
    nextAttemptAt: resetBackoff ? null : (existing?.nextAttemptAt ?? null),
    lastError: resetBackoff ? null : (existing?.lastError ?? null),
    advanceObserved: needsSync,
  };
}

export function createTranscriptSyncStore(
  prisma: Pick<DesktopPrisma, "client" | "write">
): TranscriptSyncStore {
  async function get(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptFingerprint | null> {
    const row = await prisma.client.transcriptSyncState.findUnique({
      where: { externalSessionId_fileKey: { externalSessionId, fileKey } },
    });
    return row ? toFingerprint(row) : null;
  }

  return {
    get,
    async listAll(): Promise<TranscriptFingerprint[]> {
      const rows = await prisma.client.transcriptSyncState.findMany();
      return rows.map((row) => toFingerprint(row));
    },
    async listReady(
      now: string,
      limit: number
    ): Promise<TranscriptFingerprint[]> {
      const rows = await prisma.client.transcriptSyncState.findMany({
        where: {
          status: {
            in: [TranscriptSyncStatus.Queued, TranscriptSyncStatus.Failed],
          },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        // "live" > "backfill" lexically, so desc drains live first; within a
        // class, most-recent files first (PLN-1288 recent-first backfill, so a
        // large history never delays fresh transcripts), updatedAt as a stable
        // tie-break.
        orderBy: [
          { syncClass: "desc" },
          { lastMtimeMs: "desc" },
          { updatedAt: "asc" },
        ],
        take: limit,
      });
      return rows.map((row) => toFingerprint(row));
    },
    async observe(
      input: TranscriptObserveInput
    ): Promise<TranscriptFingerprint> {
      const mtime = toBigInt(input.mtimeMs);
      const size = toBigInt(input.size);
      const where = {
        externalSessionId_fileKey: {
          externalSessionId: input.externalSessionId,
          fileKey: input.fileKey,
        },
      };
      // Read-decide-write in ONE serialized write turn so a concurrent observe
      // (sweep vs hook) for the same file cannot lost-update the status/backoff
      // computed from a stale snapshot (AGENTS.md: no read-then-write around an
      // upsert). The upserted row is returned authoritatively.
      const row = await prisma.write(async (client) => {
        const existingRow = await client.transcriptSyncState.findUnique({
          where,
        });
        const existing = existingRow ? toFingerprint(existingRow) : null;
        const next = planObservation(existing, input);
        return client.transcriptSyncState.upsert({
          where,
          create: {
            externalSessionId: input.externalSessionId,
            fileKey: input.fileKey,
            sourceHarness: input.sourceHarness,
            sourcePath: input.sourcePath,
            sourcePathHash: input.sourcePathHash,
            lastMtimeMs: mtime,
            lastSize: size,
            status: next.status,
            syncClass: next.syncClass,
            retryCount: next.retryCount,
            nextAttemptAt: next.nextAttemptAt,
            lastError: next.lastError,
            createdAt: input.now,
            updatedAt: input.now,
          },
          // Cursor fields (syncedByteOffset/syncedSha256/storedEtag/
          // syncedComputeTargetId) are deliberately NOT touched here — only
          // recordUploaded advances them. The observed mtime/size/path advance
          // ONLY when this observation is acted on (`advanceObserved`); see
          // PlannedObservation — advancing them for an `uploading` row would
          // erase the growth signal and lose lines appended mid-upload.
          update: {
            sourceHarness: input.sourceHarness,
            status: next.status,
            syncClass: next.syncClass,
            retryCount: next.retryCount,
            nextAttemptAt: next.nextAttemptAt,
            lastError: next.lastError,
            updatedAt: input.now,
            ...(next.advanceObserved
              ? {
                  sourcePath: input.sourcePath,
                  sourcePathHash: input.sourcePathHash,
                  lastMtimeMs: mtime,
                  lastSize: size,
                }
              : {}),
          },
        });
      });
      return toFingerprint(row);
    },
    async markUploading(
      externalSessionId: string,
      fileKey: string,
      now: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: { externalSessionId_fileKey: { externalSessionId, fileKey } },
          data: { status: TranscriptSyncStatus.Uploading, updatedAt: now },
        })
      );
    },
    async markIdle(
      externalSessionId: string,
      fileKey: string,
      now: string
    ): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: { externalSessionId_fileKey: { externalSessionId, fileKey } },
          data: { status: TranscriptSyncStatus.Idle, updatedAt: now },
        })
      );
    },
    async recordUploaded(input: TranscriptUploadedInput): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: {
            externalSessionId_fileKey: {
              externalSessionId: input.externalSessionId,
              fileKey: input.fileKey,
            },
          },
          data: {
            status: input.caughtUp
              ? TranscriptSyncStatus.Idle
              : TranscriptSyncStatus.Queued,
            syncedByteOffset: BigInt(Math.trunc(input.syncedByteOffset)),
            syncedSha256: input.syncedSha256,
            storedEtag: input.storedEtag,
            syncedComputeTargetId: input.syncedComputeTargetId,
            retryCount: 0,
            nextAttemptAt: null,
            lastError: null,
            updatedAt: input.now,
          },
        })
      );
    },
    async recordFailure(input: TranscriptFailureInput): Promise<void> {
      await prisma.write((client) =>
        client.transcriptSyncState.update({
          where: {
            externalSessionId_fileKey: {
              externalSessionId: input.externalSessionId,
              fileKey: input.fileKey,
            },
          },
          data: {
            status: input.dead
              ? TranscriptSyncStatus.Dead
              : TranscriptSyncStatus.Failed,
            retryCount: input.retryCount,
            nextAttemptAt: input.nextAttemptAt,
            lastError: input.lastError,
            updatedAt: input.now,
          },
        })
      );
    },
    async requeueStale(now: string): Promise<number> {
      const result = await prisma.write((client) =>
        client.transcriptSyncState.updateMany({
          where: { status: TranscriptSyncStatus.Uploading },
          data: { status: TranscriptSyncStatus.Queued, updatedAt: now },
        })
      );
      return result.count;
    },
  };
}
