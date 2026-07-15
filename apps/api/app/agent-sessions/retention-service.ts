import {
  type Prisma,
  type PrismaClient,
  SessionOrigin,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { purgeTranscriptObjectsBestEffort } from "@/lib/transcript-object-purge";

/**
 * Governance retention window (days) for synced desktop agent sessions when
 * `process.env.SESSION_RETENTION_DAYS` is unset, non-numeric, or non-positive.
 * Synced `SessionDetail` rows carry privacy-sensitive metadata (cwd,
 * repository, branch, pull requests, issues) and must not persist indefinitely.
 */
export const FALLBACK_SESSION_RETENTION_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Max sessions deleted per transaction. Bounds both the cascade-delete
 * transaction duration (the default 5s tx limit) and the `IN (...)` parameter
 * list (Postgres' 65535-parameter cap), so a large first sweep against a long
 * backlog converges across batches instead of timing out or erroring.
 */
export const SESSION_DELETE_BATCH_SIZE = 500;

export type SessionRetentionResult = {
  summary: string;
  /** ISO timestamp; sessions last active before this are purged. */
  cutoff: string;
  retentionDays: number;
  deleted: number;
  exitCode: 0 | 1;
};

type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];
type DbClient = TxClient | PrismaClient;

/**
 * Resolves the retention window from `process.env.SESSION_RETENTION_DAYS`,
 * falling back to {@link FALLBACK_SESSION_RETENTION_DAYS} when unset,
 * non-numeric, or non-positive. Read at sweep time so ops can adjust the
 * governance window via env var without a code change (matches the
 * preview-schema cleanup pattern).
 */
export function getSessionRetentionDays(): number {
  const raw = process.env.SESSION_RETENTION_DAYS;
  if (raw === undefined || raw === "") {
    return FALLBACK_SESSION_RETENTION_DAYS;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_SESSION_RETENTION_DAYS;
}

/** Cutoff instant: sessions with no genuine activity since this are expired. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Selects expired synced desktop sessions. Scoped to `DESKTOP_SYNC` origin —
 * LOOP-materialized sessions (FEA-1718) are governed by their source Loop's
 * lifecycle and are not swept here. Expiry uses `lastActivityAt` (genuine
 * agent activity) with a fallback to `sessionStartedAt` for pre-backfill rows,
 * mirroring the readers' fallback.
 */
export function expiredSessionWhere(
  cutoff: Date
): Prisma.SessionDetailWhereInput {
  return {
    origin: SessionOrigin.DESKTOP_SYNC,
    OR: [
      { lastActivityAt: { lt: cutoff } },
      { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
    ],
  };
}

export type ExpiredSessionsBatchResult = {
  /** Owning artifacts deleted this batch (cascades `SessionDetail`). */
  deleted: number;
  /**
   * Transcript `objectStorageKey`s freed by this batch, for the best-effort S3
   * purge that runs after the transaction commits.
   */
  transcriptKeys: string[];
};

/**
 * Deletes up to `batchSize` expired synced desktop sessions by removing the
 * owning artifact, so the cascade clears the `SessionDetail` row and its
 * children (events, token usage, PR links) — matching the
 * `purge-phantom-sessions` convention. Returns the number of sessions deleted
 * in this batch plus the transcript storage keys to reclaim; the caller loops
 * until a batch is short and purges the S3 objects after the tx commits.
 */
export async function purgeExpiredSessionsBatch(
  db: DbClient,
  cutoff: Date,
  batchSize: number = SESSION_DELETE_BATCH_SIZE
): Promise<ExpiredSessionsBatchResult> {
  const expired = await db.sessionDetail.findMany({
    where: expiredSessionWhere(cutoff),
    select: {
      artifactId: true,
      computeTargetId: true,
      externalSessionId: true,
    },
    take: batchSize,
  });
  if (expired.length === 0) {
    return { deleted: 0, transcriptKeys: [] };
  }
  const artifactIds = expired.map((s) => s.artifactId);
  // Collect the expiring sessions' transcript storage keys and drop those rows
  // BEFORE deleting the artifacts. Match by session identity
  // `(computeTargetId, externalSessionId)` — the `SessionTranscript` unique key
  // minus `fileKey`, the same lookup `sessionTranscriptIdentityWhere` uses on
  // the read path — NOT the nullable `sessionDetailId` FK: a transcript
  // uploaded before the metadata lane resolved its link keeps `sessionDetailId`
  // null until a later plan/complete backfills it, so a `sessionDetailId`-only
  // match would skip such a row and leave it (and its backing S3 archive, up to
  // ~53 GB per session) behind — exactly the leak this sweep exists to reclaim.
  // The identity tuple also captures the session's subagent transcript rows,
  // which share the parent's `externalSessionId` under a different `fileKey`.
  // (`SessionTranscript.sessionDetailId` is `onDelete: SetNull`, so deleting the
  // artifact — which cascades the SessionDetail — would otherwise only NULL the
  // resolved rows and never reclaim their objects.) The raw JSONL bytes live in
  // the transcripts bucket, separate from the row metadata, so once these rows
  // are gone there is no DB record of which objects to purge — hence the collect
  // step here and the best-effort purge (in the caller) after the tx commits.
  const transcriptIdentityWhere: Prisma.SessionTranscriptWhereInput = {
    OR: expired.map((s) => ({
      computeTargetId: s.computeTargetId,
      externalSessionId: s.externalSessionId,
    })),
  };
  const transcripts = await db.sessionTranscript.findMany({
    where: transcriptIdentityWhere,
    select: { objectStorageKey: true },
  });
  await db.sessionTranscript.deleteMany({
    where: transcriptIdentityWhere,
  });
  const result = await db.artifact.deleteMany({
    where: { id: { in: artifactIds } },
  });
  return {
    deleted: result.count,
    transcriptKeys: transcripts
      .map((t) => t.objectStorageKey)
      .filter((key): key is string => key.length > 0),
  };
}

export const sessionRetentionService = {
  /**
   * Purges synced desktop sessions whose last genuine activity predates the
   * governance window. Returns a structured summary; `exitCode` is 1 when the
   * sweep errored so the cron route can alert and return 500.
   */
  async runRetentionSweep(
    now: Date = new Date(),
    retentionDays: number = getSessionRetentionDays()
  ): Promise<SessionRetentionResult> {
    const cutoff = retentionCutoff(now, retentionDays);
    try {
      // Delete in bounded per-batch transactions: each batch finds + deletes
      // atomically (so a session receiving a fresh sync mid-batch is not purged
      // half-updated), and the loop converges a large backlog within one run
      // without a single oversized transaction.
      let deleted = 0;
      for (;;) {
        const batch = await withDb.tx((tx) =>
          purgeExpiredSessionsBatch(tx, cutoff)
        );
        deleted += batch.deleted;
        // Reclaim the batch's transcript archives only after its transaction has
        // committed, so a storage failure is contained to logging and never
        // rolls back the row delete.
        await purgeTranscriptObjectsBestEffort(
          batch.transcriptKeys,
          "[cleanup-expired-sessions] failed to purge transcript objects after session retention delete",
          { cutoff: cutoff.toISOString() }
        );
        if (batch.deleted < SESSION_DELETE_BATCH_SIZE) {
          break;
        }
      }
      return {
        summary: `Deleted ${deleted} expired desktop session(s) inactive > ${retentionDays}d (cutoff ${cutoff.toISOString()})`,
        cutoff: cutoff.toISOString(),
        retentionDays,
        deleted,
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[cleanup-expired-sessions] retention sweep failed", {
        error: message,
        retentionDays,
        cutoff: cutoff.toISOString(),
      });
      return {
        summary: `Session retention sweep failed: ${message}`,
        cutoff: cutoff.toISOString(),
        retentionDays,
        deleted: 0,
        exitCode: 1,
      };
    }
  },
};
