import {
  type Prisma,
  type PrismaClient,
  SessionOrigin,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { purgeTranscriptObjectsBestEffort } from "@/lib/transcript-object-purge";
import {
  SESSION_DELETE_BATCH_SIZE,
  type SessionRetentionResult,
} from "./retention-service";
import { resolvePositiveEnvNumber } from "./service/env-config";
import {
  SESSION_HAS_PR_WHERE,
  SESSION_IDLE_WHERE,
} from "./service/query-builder";

/**
 * FEA-3286: how old (hours) an idle session's last activity must be before the
 * phantom purge reclaims it, when `process.env.PHANTOM_SESSION_AGE_HOURS` is
 * unset, non-numeric, or non-positive.
 *
 * This age gate is the late-chunk safety guard. The desktop can sync a session
 * in chunks (a large transcript, or a session that only just gained its first
 * token), so a row that is idle RIGHT NOW might receive a substantive chunk
 * seconds later. Requiring the row to have been quiet for N hours — combined
 * with re-finding fresh candidates inside the delete transaction (so a row that
 * turned substantive between find and delete is re-excluded) — means a session
 * mid-sync is never purged out from under the desktop.
 */
export const FALLBACK_PHANTOM_SESSION_AGE_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Resolves the phantom-age window (hours) from
 * `process.env.PHANTOM_SESSION_AGE_HOURS`, falling back to
 * {@link FALLBACK_PHANTOM_SESSION_AGE_HOURS} when unset, non-numeric, or
 * non-positive. Read at sweep time so ops can tune the guard without a code
 * change (mirrors `getSessionRetentionDays`).
 */
export function getPhantomSessionAgeHours(): number {
  return resolvePositiveEnvNumber(
    "PHANTOM_SESSION_AGE_HOURS",
    FALLBACK_PHANTOM_SESSION_AGE_HOURS
  );
}

/** Cutoff instant: idle sessions last active before this are purgeable. */
export function phantomCutoff(now: Date, ageHours: number): Date {
  return new Date(now.getTime() - ageHours * MS_PER_HOUR);
}

type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];
type DbClient = TxClient | PrismaClient;

/**
 * FEA-3286: the phantom-session predicate. A row is a purgeable phantom when ALL
 * of the following hold, so no real work is ever lost:
 *
 *  1. **Idle** — `SESSION_IDLE_WHERE`, the exported inverse of the FEA-3284
 *     `isSubstantiveSession` SSOT: null/≤0 turns AND zero of every token AND no
 *     tool use. This is the SAME predicate the read filter and (inverted) the
 *     desktop sync gate (FEA-3287) use, so purge/read/sync agree on "phantom".
 *  2. **Aged** — last activity older than the cutoff (the late-chunk guard; see
 *     `FALLBACK_PHANTOM_SESSION_AGE_HOURS`). Uses `lastActivityAt` with a
 *     `sessionStartedAt` fallback for pre-backfill rows, mirroring the readers
 *     and the retention sweep.
 *  3. **No pull request** — NOT `SESSION_HAS_PR_WHERE`. A session that produced
 *     a PR is meaningful even if its turn/token rollup reads zero, so it is
 *     spared unconditionally (belt-and-suspenders over the idle gate).
 *  4. **Synced-desktop origin** — LOOP-materialized sessions (FEA-1718) are
 *     governed by their source Loop's lifecycle and are never swept here, exactly
 *     like the retention sweep.
 *
 * The generalization over the old one-off `purge-phantom-sessions.ts` (which
 * only matched a narrow Codex re-serialization burst: <5s span, ≥20 events, 0
 * tokens) is the idle predicate: it now covers the common 0-turn / 0-token /
 * no-tool-use / short-lived-abandoned cases the burst signature missed.
 */
export function phantomSessionWhere(
  cutoff: Date,
  orgId: string | null
): Prisma.SessionDetailWhereInput {
  const idleAged: Prisma.SessionDetailWhereInput = {
    origin: SessionOrigin.DESKTOP_SYNC,
    AND: [
      SESSION_IDLE_WHERE,
      {
        OR: [
          { lastActivityAt: { lt: cutoff } },
          { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
        ],
      },
      { NOT: SESSION_HAS_PR_WHERE },
    ],
  };
  if (orgId) {
    // Org-scoped safety: bound the sweep to one organization when requested
    // (matches the one-off script's ORG_ID guard). Absent → all orgs.
    idleAged.artifact = { is: { organizationId: orgId } };
  }
  return idleAged;
}

export type PhantomSessionsBatchResult = {
  /** Owning artifacts deleted this batch (cascades `SessionDetail`). */
  deleted: number;
  /** Transcript `objectStorageKey`s freed by this batch (S3 reclaim). */
  transcriptKeys: string[];
};

/**
 * Deletes up to `batchSize` phantom sessions by removing the owning artifact so
 * the cascade clears the `SessionDetail` row and its children — matching the
 * `purge-phantom-sessions` / retention convention. Re-evaluates candidates via
 * {@link phantomSessionWhere} on every call, so when run inside the delete
 * transaction a row that gained substantive activity (a late chunk) between two
 * calls is naturally re-excluded. Also reclaims each purged session's transcript
 * archive keys, mirroring the retention sweep.
 */
export async function purgePhantomSessionsBatch(
  db: DbClient,
  cutoff: Date,
  orgId: string | null,
  batchSize: number = SESSION_DELETE_BATCH_SIZE
): Promise<PhantomSessionsBatchResult> {
  const phantoms = await db.sessionDetail.findMany({
    where: phantomSessionWhere(cutoff, orgId),
    select: {
      artifactId: true,
      computeTargetId: true,
      externalSessionId: true,
    },
    take: batchSize,
  });
  if (phantoms.length === 0) {
    return { deleted: 0, transcriptKeys: [] };
  }
  const artifactIds = phantoms.map((s) => s.artifactId);
  // Collect + drop the transcript rows by session identity
  // (computeTargetId, externalSessionId) BEFORE deleting the artifacts — the
  // same reclaim the retention sweep performs, because `SessionTranscript`
  // rows are `onDelete: SetNull` on the SessionDetail FK and would otherwise
  // leave their S3 objects orphaned. (A phantom session rarely has a transcript,
  // but a burst-created one can, so the reclaim is kept for parity/safety.)
  const transcriptIdentityWhere: Prisma.SessionTranscriptWhereInput = {
    OR: phantoms.map((s) => ({
      computeTargetId: s.computeTargetId,
      externalSessionId: s.externalSessionId,
    })),
  };
  const transcripts = await db.sessionTranscript.findMany({
    where: transcriptIdentityWhere,
    select: { objectStorageKey: true },
  });
  await db.sessionTranscript.deleteMany({ where: transcriptIdentityWhere });
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

export const phantomRetentionService = {
  /**
   * Purges idle ("phantom") synced desktop sessions — 0-turn / 0-token /
   * no-tool-use / abandoned rows aged past the phantom window and carrying no
   * pull request. Returns a structured summary; `exitCode` is 1 when the sweep
   * errored so the cron route can alert and return 500.
   */
  async runPhantomSweep(
    now: Date = new Date(),
    ageHours: number = getPhantomSessionAgeHours(),
    orgId: string | null = null
  ): Promise<SessionRetentionResult> {
    const cutoff = phantomCutoff(now, ageHours);
    try {
      // Bounded per-batch transactions: each batch re-finds + deletes atomically
      // (so a session receiving a late substantive chunk mid-batch is re-excluded
      // and never purged half-substantive), and the loop converges a large idle
      // backlog across batches without one oversized transaction.
      let deleted = 0;
      for (;;) {
        const batch = await withDb.tx((tx) =>
          purgePhantomSessionsBatch(tx, cutoff, orgId)
        );
        deleted += batch.deleted;
        // Reclaim transcript archives only AFTER the transaction commits, so a
        // storage failure is contained to logging and never rolls back the row
        // delete.
        await purgeTranscriptObjectsBestEffort(
          batch.transcriptKeys,
          "[cleanup-phantom-sessions] failed to purge transcript objects after phantom session delete",
          { cutoff: cutoff.toISOString() }
        );
        if (batch.deleted < SESSION_DELETE_BATCH_SIZE) {
          break;
        }
      }
      return {
        summary: `Deleted ${deleted} phantom desktop session(s) idle > ${ageHours}h (cutoff ${cutoff.toISOString()})`,
        cutoff: cutoff.toISOString(),
        retentionDays: ageHours / 24,
        deleted,
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[cleanup-phantom-sessions] phantom sweep failed", {
        error: message,
        ageHours,
        cutoff: cutoff.toISOString(),
      });
      return {
        summary: `Phantom session sweep failed: ${message}`,
        cutoff: cutoff.toISOString(),
        retentionDays: ageHours / 24,
        deleted: 0,
        exitCode: 1,
      };
    }
  },
};
