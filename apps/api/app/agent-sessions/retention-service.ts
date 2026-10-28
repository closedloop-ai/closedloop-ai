import {
  type Prisma,
  type PrismaClient,
  SessionOrigin,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import {
  IndexKeyOrigin,
  indexKeyLookupCandidates,
} from "@/lib/index-key-lookup";
import { purgeTranscriptObjectsBestEffort } from "@/lib/transcript-object-purge";
import { resolvePositiveEnvNumber } from "./service/env-config";

/**
 * Governance retention window (days) for synced desktop agent sessions when
 * `process.env.SESSION_RETENTION_DAYS` is unset, non-numeric, or non-positive.
 * Synced `SessionDetail` rows carry privacy-sensitive metadata (cwd,
 * repository, branch, pull requests, issues) and must not persist indefinitely.
 */
export const FALLBACK_SESSION_RETENTION_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Abandoned invocation generations may contain private definition content. */
export const INCOMPLETE_INVOCATION_GENERATION_RETENTION_HOURS = 24;

/** Bounds cascade work for generation parts and invocation rows per transaction. */
export const INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE = 100;

export type IncompleteInvocationGenerationBatchResult = {
  candidateCount: number;
  deleted: number;
};

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
  return resolvePositiveEnvNumber(
    "SESSION_RETENTION_DAYS",
    FALLBACK_SESSION_RETENTION_DAYS
  );
}

/** Cutoff instant: sessions with no genuine activity since this are expired. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Selects expired synced desktop sessions. Scoped to `DESKTOP_SYNC` origin;
 * ISS-12435 remapped stored LOOP-origin rows to `DESKTOP_SYNC` when Loops were
 * retired. Expiry uses `lastActivityAt` (genuine agent
 * activity), which ISS-6463 made NOT NULL — the `sessionStartedAt` fallback that
 * used to sit beside it covered pre-backfill rows that no longer exist.
 */
export function expiredSessionWhere(
  cutoff: Date
): Prisma.SessionDetailWhereInput {
  return {
    origin: SessionOrigin.DESKTOP_SYNC,
    lastActivityAt: { lt: cutoff },
  };
}

export type ExpiredSessionsBatchResult = {
  /**
   * Expired sessions SELECTED this batch — the loop's stop condition. `deleted`
   * can fall short of it without the population being exhausted, so reading the
   * delete count as "nothing left to do" ends a sweep early (ISS-10164).
   */
  candidateCount: number;
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
 * `purge-phantom-sessions` convention. Returns the candidates selected and the
 * sessions actually deleted in this batch plus the transcript storage keys to
 * reclaim; the caller loops until a batch SELECTS fewer candidates than the
 * batch size and purges the S3 objects after the tx commits.
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
    // ISS-10164: oldest-expired first, terminated by the primary key. Without a
    // UNIQUE terminal key the page has no defined answer for rows tied on
    // `lastActivityAt`, so successive batches can re-serve or skip tied rows as
    // the planner pleases; `artifactId` is `SessionDetail`'s `@id`, which makes
    // the ordering total. `@@index([lastActivityAt])` covers the leading key.
    orderBy: [{ lastActivityAt: "asc" }, { artifactId: "asc" }],
    take: batchSize,
  });
  if (expired.length === 0) {
    return { candidateCount: 0, deleted: 0, transcriptKeys: [] };
  }
  const artifactIds = expired.map((s) => s.artifactId);
  // ISS-10164 (review, whitlockk): the DELETE REPEATS the expiry predicate, so a
  // session that took a fresh sync between this batch's SELECT and its DELETE is
  // spared instead of cascaded on the strength of a captured id. The sibling
  // `purgeIncompleteInvocationGenerationsBatch` below has always done this; this
  // site did not, and an id-only delete is the whole distance between "reclaim
  // what expired" and "reclaim what was expired a moment ago".
  const result = await db.artifact.deleteMany({
    where: { id: { in: artifactIds }, session: expiredSessionWhere(cutoff) },
  });
  // Reclaim transcripts ONLY for the rows that actually went away. Deleting the
  // artifact cascades its `SessionDetail`, so an id that still has one survived
  // the guarded delete above — and its transcripts, and the S3 archives behind
  // them, must survive with it. Ordering this after the delete is what makes
  // that knowable: the previous order removed every candidate's transcript rows
  // first, so a spared session lost its archive metadata anyway and the objects
  // it names became unreclaimable.
  //
  // MATCHED BY SESSION IDENTITY `(computeTargetId, externalSessionId)` — the
  // `SessionTranscript` unique key minus `fileKey`, the same lookup
  // `sessionTranscriptIdentityWhere` uses on the read path — and NOT the
  // nullable `sessionDetailId` FK. A transcript uploaded before the metadata
  // lane resolved its link keeps `sessionDetailId` null until a later
  // plan/complete backfills it, so an FK-only match would skip such a row and
  // leave it (and its backing S3 archive, up to ~53 GB per session) behind —
  // exactly the leak this sweep exists to reclaim. The tuple also captures the
  // session's subagent transcript rows, which share the parent's
  // `externalSessionId` under a different `fileKey`.
  //
  // Those identity columns live on `SessionTranscript` itself, so the cascade
  // never touches them and the match still works AFTER the artifact delete —
  // which is what makes "only the rows that actually went away" expressible.
  // (`sessionDetailId` is `onDelete: SetNull`, so the cascade would otherwise
  // only NULL the resolved rows and never reclaim their objects.) The raw JSONL
  // bytes live in the transcripts bucket, separate from the row metadata, so
  // once these rows are gone there is no DB record of which objects to purge —
  // hence collecting the keys here and the best-effort purge in the caller once
  // the tx commits.
  const survivors = await db.sessionDetail.findMany({
    where: { artifactId: { in: artifactIds } },
    select: { artifactId: true },
  });
  const survivingIds = new Set(survivors.map((s) => s.artifactId));
  const vanished = expired.filter((s) => !survivingIds.has(s.artifactId));
  if (vanished.length === 0) {
    return {
      candidateCount: expired.length,
      deleted: result.count,
      transcriptKeys: [],
    };
  }
  // ISS-8200: `s.externalSessionId` was READ BACK out of `SessionDetail`, so it
  // is whatever that column stores — projected for a session ISS-8069 re-keyed.
  // `SessionTranscript.externalSessionId` was written RAW until ISS-8125 began
  // projecting it at the same budget, so the two columns can hold DIFFERENT
  // strings for one session and a plain equality `OR` matches neither. The
  // session is then deleted while its transcript rows — and the S3 objects they
  // name, up to ~53 GB each — are left behind with no DB record of what to
  // purge, and this sweep silently stops completing. `storedIndexKeyCandidates`
  // is the stored-value rule (never re-project a value that has already been
  // through a column — ISS-8254), so it offers the stored key plus the key a
  // pre-ISS-8125 raw row would hold.
  const vanishedIdentityWhere: Prisma.SessionTranscriptWhereInput = {
    OR: vanished.map((s) => ({
      computeTargetId: s.computeTargetId,
      externalSessionId: {
        in: indexKeyLookupCandidates(
          s.externalSessionId,
          IndexKeyOrigin.Stored
        ),
      },
    })),
  };
  const transcripts = await db.sessionTranscript.findMany({
    where: vanishedIdentityWhere,
    select: { objectStorageKey: true },
  });
  await db.sessionTranscript.deleteMany({
    where: vanishedIdentityWhere,
  });
  return {
    candidateCount: expired.length,
    deleted: result.count,
    transcriptKeys: transcripts
      .map((t) => t.objectStorageKey)
      .filter((key): key is string => key.length > 0),
  };
}

/**
 * Deletes one bounded batch of abandoned invocation generations across every
 * session. The delete repeats the incomplete + cutoff predicates so a row that
 * completes or receives a fresh part after candidate selection is preserved.
 */
export async function purgeIncompleteInvocationGenerationsBatch(
  db: DbClient,
  cutoff: Date,
  batchSize: number = INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE
): Promise<IncompleteInvocationGenerationBatchResult> {
  const incompleteWhere = {
    activeAt: null,
    completedAt: null,
    updatedAt: { lt: cutoff },
  } satisfies Prisma.AgentComponentInvocationGenerationWhereInput;
  const generations = await db.agentComponentInvocationGeneration.findMany({
    where: incompleteWhere,
    select: { id: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  if (generations.length === 0) {
    return { candidateCount: 0, deleted: 0 };
  }
  const result = await db.agentComponentInvocationGeneration.deleteMany({
    where: {
      id: { in: generations.map((generation) => generation.id) },
      ...incompleteWhere,
    },
  });
  return { candidateCount: generations.length, deleted: result.count };
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
    const incompleteInvocationCutoff = new Date(
      now.getTime() -
        INCOMPLETE_INVOCATION_GENERATION_RETENTION_HOURS * 60 * 60 * 1000
    );
    try {
      let deletedIncompleteInvocationGenerations = 0;
      for (;;) {
        const batch = await withDb.tx((tx) =>
          purgeIncompleteInvocationGenerationsBatch(
            tx,
            incompleteInvocationCutoff
          )
        );
        deletedIncompleteInvocationGenerations += batch.deleted;
        // Stop on the number selected, not the number deleted. A candidate can
        // receive a fresh part or activate between the SELECT and guarded
        // DELETE; that preservation must not hide stale rows beyond this page.
        // On the next transaction the preserved row no longer matches, so a
        // fully raced batch advances rather than looping over the same rows.
        if (
          batch.candidateCount <
          INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE
        ) {
          break;
        }
      }

      // Delete in bounded per-batch transactions: each batch finds + deletes
      // atomically (so a session receiving a fresh sync mid-batch is not purged
      // half-updated), and the loop converges a large backlog within one run
      // without a single oversized transaction.
      let deleted = 0;
      let vanishedExpiredCandidates = 0;
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
        // A row can be deleted by a concurrent writer between this batch's
        // SELECT and its DELETE, so the delete count understates the page that
        // was actually consumed. Report that shortfall rather than leaving it to
        // be inferred from a small number.
        if (batch.deleted < batch.candidateCount) {
          vanishedExpiredCandidates += batch.candidateCount - batch.deleted;
          log.warn(
            "[cleanup-expired-sessions] expired session candidates vanished between select and delete",
            {
              candidateCount: batch.candidateCount,
              deleted: batch.deleted,
              cutoff: cutoff.toISOString(),
            }
          );
        }
        // Stop on the number SELECTED, not the number deleted (ISS-10164). A
        // candidate removed by a concurrent writer after selection is not
        // evidence that the population is exhausted; on the next transaction it
        // no longer matches, so a fully raced batch advances rather than looping
        // over the same rows.
        if (batch.candidateCount < SESSION_DELETE_BATCH_SIZE) {
          break;
        }
      }
      return {
        summary: `Deleted ${deleted} expired desktop session(s) inactive > ${retentionDays}d (cutoff ${cutoff.toISOString()}) and ${deletedIncompleteInvocationGenerations} incomplete invocation generation(s) older than ${INCOMPLETE_INVOCATION_GENERATION_RETENTION_HOURS}h${vanishedExpiredCandidates > 0 ? ` (${vanishedExpiredCandidates} expired session candidate(s) vanished between select and delete)` : ""}`,
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
