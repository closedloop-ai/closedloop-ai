import { type Prisma, type PrismaClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * FEA-3789 (PRD-536 G3): backfill re-link for orphaned session transcripts.
 *
 * `SessionTranscript.sessionDetailId` (nullable, `onDelete: SetNull`) is
 * resolved lazily on the transcript sync/complete/skip path from the session
 * identity `(computeTargetId, externalSessionId)` — but ONLY when that path
 * runs again. A transcript that finishes uploading BEFORE its `SessionDetail`
 * metadata arrives never re-plans, so it stays `sessionDetailId = null`
 * forever: permanently orphaned from the session it belongs to, invisible to
 * any reader that joins through the FK.
 *
 * The lazy relink (in `apps/api/app/desktop/transcripts/service.ts`,
 * `resolveSessionDetailId`) and the retention/phantom sweeps (which reap
 * transcript rows by identity when a session is deleted) already exist; what is
 * missing is a periodic backfill that retroactively links transcripts that are
 * ALREADY orphaned. This service is that backfill, wired to a daily cron.
 *
 * It reuses the SAME identity match as the lazy relink and the retention sweep:
 * `(computeTargetId, externalSessionId)` → `SessionDetail.artifactId`. The
 * lookup is index-supported by the existing `SessionTranscript`
 * `@@unique([computeTargetId, externalSessionId, fileKey])` (its leading
 * prefix) and `SessionDetail`'s `@@unique([computeTargetId, externalSessionId])`
 * — no new migration is required. (The additional standalone
 * `@@index([computeTargetId, externalSessionId])` and the concurrency fix
 * tracked in sibling FEA-3480 are a separate, out-of-scope decision.)
 */

/**
 * Max orphaned transcripts scanned + linked per pass. Bounds the per-pass work
 * and the `IN (...)` parameter list, so a large first sweep against a long
 * orphan backlog converges across batches instead of doing one oversized scan
 * (mirrors `SESSION_DELETE_BATCH_SIZE` in the retention sweep).
 */
export const TRANSCRIPT_BACKFILL_BATCH_SIZE = 500;

export type TranscriptBackfillResult = {
  summary: string;
  /** Orphaned transcript rows re-linked to their session this run. */
  linked: number;
  /**
   * Orphaned rows scanned whose session identity still has no `SessionDetail`
   * (metadata genuinely not arrived yet). Not an error — reported for
   * observability so a persistently non-zero value is visible.
   */
  unresolved: number;
  exitCode: 0 | 1;
};

type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];
type DbClient = TxClient | PrismaClient;

/**
 * Orphaned = the transcript row exists but its `sessionDetailId` FK is unset.
 * A row can be orphaned in ANY upload status (the fully-uploaded case is the
 * one this backfill exists for — those never re-plan — but a still-uploading or
 * skipped orphan is linked too, matching the lazy relink which resolves the id
 * on every path regardless of status).
 */
export const ORPHANED_TRANSCRIPT_WHERE: Prisma.SessionTranscriptWhereInput = {
  sessionDetailId: null,
};

/**
 * Re-link one batch of orphaned transcripts to their `SessionDetail` by session
 * identity `(computeTargetId, externalSessionId)`. Groups the scanned orphans
 * by identity so each distinct session is resolved once, then issues one
 * `updateMany` per resolvable identity — matching the parent AND its subagent
 * transcript rows (which share the identity under a different `fileKey`) in a
 * single statement. Returns the count linked plus the count left unresolved
 * (session metadata not yet present).
 */
export async function backfillOrphanTranscriptsBatch(
  db: DbClient,
  batchSize: number = TRANSCRIPT_BACKFILL_BATCH_SIZE
): Promise<{ linked: number; unresolved: number; scanned: number }> {
  const orphans = await db.sessionTranscript.findMany({
    where: ORPHANED_TRANSCRIPT_WHERE,
    select: { computeTargetId: true, externalSessionId: true },
    take: batchSize,
  });
  if (orphans.length === 0) {
    return { linked: 0, unresolved: 0, scanned: 0 };
  }

  // Distinct session identities in this batch (parent + subagent rows collapse
  // to one identity), so each session is resolved with a single findUnique and
  // linked with a single updateMany that catches every one of its files.
  const identities = new Map<
    string,
    { computeTargetId: string; externalSessionId: string }
  >();
  for (const orphan of orphans) {
    identities.set(
      `${orphan.computeTargetId}\u0000${orphan.externalSessionId}`,
      {
        computeTargetId: orphan.computeTargetId,
        externalSessionId: orphan.externalSessionId,
      }
    );
  }

  let linked = 0;
  let unresolved = 0;
  for (const identity of identities.values()) {
    // Same identity resolution as the transcript service's lazy relink:
    // (computeTargetId, externalSessionId) → SessionDetail.artifactId.
    const detail = await db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: identity.computeTargetId,
          externalSessionId: identity.externalSessionId,
        },
      },
      select: { artifactId: true },
    });
    if (!detail) {
      // Metadata still hasn't arrived — leave the row orphaned; a later run (or
      // a fresh plan/complete) links it once the SessionDetail exists.
      unresolved += 1;
      continue;
    }
    // Re-scope the update to still-orphaned rows for this identity, so a row
    // linked by a concurrent plan/complete between the scan and here is not
    // clobbered.
    const result = await db.sessionTranscript.updateMany({
      where: {
        computeTargetId: identity.computeTargetId,
        externalSessionId: identity.externalSessionId,
        sessionDetailId: null,
      },
      data: { sessionDetailId: detail.artifactId },
    });
    linked += result.count;
  }

  return { linked, unresolved, scanned: orphans.length };
}

export const transcriptBackfillService = {
  /**
   * Re-links orphaned `SessionTranscript` rows to their `SessionDetail` by
   * session identity. Loops in bounded per-batch passes until a scan comes up
   * short, so a large orphan backlog converges across batches within one run.
   * Returns a structured summary; `exitCode` is 1 when the sweep errored so the
   * cron route can alert and return 500.
   *
   * Deliberately NOT wrapped in `withDb.tx`: a batch can resolve up to
   * `TRANSCRIPT_BACKFILL_BATCH_SIZE` distinct session identities, each a
   * sequential `findUnique` + `updateMany`, which on a large backlog would blow
   * the interactive transaction's default 5s ceiling and roll back the whole
   * batch — starving progress forever. Cross-identity atomicity buys nothing
   * here: each per-identity `updateMany` is independently correct and re-scoped
   * to `sessionDetailId: null`, so it is idempotent and safe against a
   * concurrent plan/complete relink. Batches simply resume the scan next pass.
   */
  async runBackfill(): Promise<TranscriptBackfillResult> {
    try {
      let linked = 0;
      let unresolved = 0;
      for (;;) {
        const batch = await withDb((db) => backfillOrphanTranscriptsBatch(db));
        linked += batch.linked;
        unresolved += batch.unresolved;
        // A short scan means we've drained the current orphan backlog. Unresolved
        // rows (no SessionDetail yet) count toward the scan, so once every
        // remaining orphan is unresolvable the scan stabilizes and we stop —
        // rather than spinning forever re-scanning the same unlinkable rows.
        if (
          batch.scanned < TRANSCRIPT_BACKFILL_BATCH_SIZE ||
          batch.linked === 0
        ) {
          break;
        }
      }
      return {
        summary: `Re-linked ${linked} orphaned transcript(s); ${unresolved} awaiting session metadata`,
        linked,
        unresolved,
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[backfill-orphan-transcripts] backfill sweep failed", {
        error: message,
      });
      return {
        summary: `Orphan transcript backfill failed: ${message}`,
        linked: 0,
        unresolved: 0,
        exitCode: 1,
      };
    }
  },
};
