import { type Prisma, type PrismaClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { storedIndexKeyCandidates } from "@/lib/index-key-projection";

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
 * ALREADY orphaned. This service is that backfill, behind
 * `/cron/backfill-orphan-transcripts`, which ISS-12780 unscheduled.
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
  /**
   * Identities whose resolved `SessionDetail` was deleted between the batch
   * read and the write. Counted separately from {@link unresolved}: that one
   * means metadata has not arrived, this one means the session is gone. Not an
   * error — the rows correctly stay unlinked — but a persistently non-zero
   * value means the sweep is racing retention hard enough to be worth seeing.
   */
  staleParent: number;
  exitCode: 0 | 1;
};

/** Prisma's foreign-key constraint violation. */
const FOREIGN_KEY_VIOLATION_CODE = "P2003";

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
 * by identity, resolves every identity in the batch with ONE read, then issues
 * one `updateMany` per resolvable identity — matching the parent AND its
 * subagent transcript rows (which share the identity under a different
 * `fileKey`) in a single statement. Returns the count linked plus the count
 * left unresolved (session metadata not yet present).
 */
export async function backfillOrphanTranscriptsBatch(
  db: DbClient,
  batchSize: number = TRANSCRIPT_BACKFILL_BATCH_SIZE
): Promise<{
  linked: number;
  unresolved: number;
  staleParent: number;
  scanned: number;
}> {
  const orphans = await db.sessionTranscript.findMany({
    where: ORPHANED_TRANSCRIPT_WHERE,
    select: { computeTargetId: true, externalSessionId: true },
    take: batchSize,
  });
  if (orphans.length === 0) {
    return { linked: 0, unresolved: 0, staleParent: 0, scanned: 0 };
  }

  // Distinct session identities in this batch (parent + subagent rows collapse
  // to one identity), so each session is resolved once and linked with a single
  // updateMany that catches every one of its files.
  const identities = new Map<string, BatchIdentity>();
  for (const orphan of orphans) {
    const key = sessionDetailKey(
      orphan.computeTargetId,
      orphan.externalSessionId
    );
    if (identities.has(key)) {
      continue;
    }
    identities.set(key, {
      computeTargetId: orphan.computeTargetId,
      externalSessionId: orphan.externalSessionId,
      candidates: storedIndexKeyCandidates(orphan.externalSessionId),
    });
  }

  // ISS-9118: one read resolves the whole batch. This was a `findFirst` per
  // identity inside the loop below — up to TRANSCRIPT_BACKFILL_BATCH_SIZE
  // serial round trips, measured at 55% of a full batch's database time.
  const artifactIdByStoredKey = await readSessionDetailArtifactIds(
    db,
    identities
  );

  let linked = 0;
  let unresolved = 0;
  let staleParent = 0;
  for (const identity of identities.values()) {
    const artifactId = await resolveArtifactId(
      db,
      identity,
      artifactIdByStoredKey
    );
    if (!artifactId) {
      // Metadata still hasn't arrived — leave the row orphaned; a later run (or
      // a fresh plan/complete) links it once the SessionDetail exists.
      unresolved += 1;
      continue;
    }
    const count = await linkIdentityTranscripts(db, identity, artifactId);
    if (count === null) {
      staleParent += 1;
      continue;
    }
    linked += count;
  }

  return { linked, unresolved, staleParent, scanned: orphans.length };
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
   * sequential `updateMany`, which on a large backlog would blow
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
      let staleParent = 0;
      for (;;) {
        const batch = await withDb((db) => backfillOrphanTranscriptsBatch(db));
        linked += batch.linked;
        unresolved += batch.unresolved;
        staleParent += batch.staleParent;
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
        summary: `Re-linked ${linked} orphaned transcript(s); ${unresolved} awaiting session metadata; ${staleParent} identity/identities whose session was deleted mid-run`,
        linked,
        unresolved,
        staleParent,
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
        staleParent: 0,
        exitCode: 1,
      };
    }
  },
};

/**
 * A distinct session identity in one scanned batch, with the stored keys a
 * `SessionDetail` for it could be filed under.
 *
 * ISS-8125: the transcript column already holds the STORED value, so candidate
 * one is that value verbatim. Re-projecting it is the bug this call site used
 * to have — `projectIndexKey` is deliberately not idempotent (ISS-8254 reserved
 * the marker), so a second projection lands on a key no `SessionDetail` holds
 * and the orphan is silently counted `unresolved` forever. Candidate two, when
 * there is one, covers a row written before that projection existed.
 */
type BatchIdentity = {
  computeTargetId: string;
  externalSessionId: string;
  /** Stored keys to try, in precedence order. */
  candidates: string[];
};

/** The pair `SessionDetail` is unique on, as one lookup key. */
function sessionDetailKey(
  computeTargetId: string,
  externalSessionId: string
): string {
  return `${computeTargetId}\u0000${externalSessionId}`;
}

/**
 * One read for the whole batch: the same `(computeTargetId, externalSessionId)`
 * → `SessionDetail.artifactId` match the lazy relink makes, ORed across every
 * identity so the scan costs one statement rather than one per session.
 */
async function readSessionDetailArtifactIds(
  db: DbClient,
  identities: Map<string, BatchIdentity>
): Promise<Map<string, string>> {
  const rows = await db.sessionDetail.findMany({
    where: {
      OR: [...identities.values()].map((identity) => ({
        computeTargetId: identity.computeTargetId,
        externalSessionId: { in: identity.candidates },
      })),
    },
    select: {
      artifactId: true,
      computeTargetId: true,
      externalSessionId: true,
    },
  });
  return new Map(
    rows.map((row) => [
      sessionDetailKey(row.computeTargetId, row.externalSessionId),
      row.artifactId,
    ])
  );
}

/**
 * An identity carrying a projected sibling candidate can match two
 * `SessionDetail` rows — the raw key and its projected sibling are different
 * rows under the `(computeTargetId, externalSessionId)` unique — and the batch
 * read returns both, where the replaced per-identity `findFirst` had no
 * `orderBy` and picked between them arbitrarily.
 *
 * Choosing here would decide that selection, permanently assigning a different
 * `sessionDetailId` than the prior cron could have — a behavior change riding
 * inside a performance change. So a genuine multi-match re-issues the ORIGINAL
 * query for that one identity and lets it pick exactly as before; this module
 * deliberately does not rank the candidates. Ambiguity needs a legacy
 * over-budget id filed under BOTH its raw and projected keys, so the fallback
 * is effectively never taken and a pass still costs one read.
 */
async function resolveArtifactId(
  db: DbClient,
  identity: BatchIdentity,
  artifactIdByStoredKey: Map<string, string>
): Promise<string | undefined> {
  const matched = new Set(
    identity.candidates
      .map((candidate) =>
        artifactIdByStoredKey.get(
          sessionDetailKey(identity.computeTargetId, candidate)
        )
      )
      .filter((artifactId): artifactId is string => artifactId !== undefined)
  );
  if (matched.size <= 1) {
    const [only] = matched;
    return only;
  }
  const detail = await db.sessionDetail.findFirst({
    where: {
      computeTargetId: identity.computeTargetId,
      externalSessionId: { in: identity.candidates },
    },
    select: { artifactId: true },
  });
  return detail?.artifactId;
}

/**
 * Link one identity's still-orphaned transcript rows. Returns the row count, or
 * `null` when the resolved `SessionDetail` no longer exists.
 *
 * Re-scoping to `sessionDetailId: null` keeps a row linked by a concurrent
 * plan/complete from being clobbered, but it does NOT make the write safe
 * against a deleted parent: the batched read widened the window between
 * resolving `artifactId` and writing it, and nothing holds the parent open
 * across it. A retention/phantom sweep can drop the `SessionDetail` after the
 * read, and a transcript row for the SAME identity can be (re-)created orphaned
 * right after — transcript planning permits a null FK before the metadata
 * exists — so a still-orphaned row IS there to match and the write names a
 * deleted parent. Postgres rejects it with a foreign-key violation.
 *
 * Absorb that per identity. `updateMany` is a single statement, so nothing
 * partial lands, and this sweep is deliberately not transactional (see
 * `runBackfill`) — one vanished session must not abort the identities behind it
 * or discard the links already committed this pass.
 */
async function linkIdentityTranscripts(
  db: DbClient,
  identity: BatchIdentity,
  artifactId: string
): Promise<number | null> {
  try {
    const result = await db.sessionTranscript.updateMany({
      where: {
        computeTargetId: identity.computeTargetId,
        externalSessionId: identity.externalSessionId,
        sessionDetailId: null,
      },
      data: { sessionDetailId: artifactId },
    });
    return result.count;
  } catch (error) {
    if (getPrismaErrorCode(error) !== FOREIGN_KEY_VIOLATION_CODE) {
      throw error;
    }
    return null;
  }
}
