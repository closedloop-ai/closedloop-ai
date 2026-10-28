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
 * The age gate reads session-time (`lastActivityAt`), never receive-time, so a
 * historical session being re-parsed can satisfy it as soon as chunk 0 commits.
 * Re-finding candidates inside the delete transaction still excludes a row that
 * turned substantive, while the `pendingChunkRevision: null` predicate is what
 * excludes a session whose partial rebuild still presents the idle shape.
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
 *     tool use AND no component invocation (ISS-5801 — an invocation-only
 *     session is real work; purging it would re-orphan its invocation children
 *     as terminal `session_missing`). This is the SAME predicate the read
 *     filter and (inverted) the desktop sync gate (FEA-3287) use, so
 *     purge/read/sync agree on "phantom".
 *  2. **Aged** — last activity older than the cutoff. Uses `lastActivityAt`,
 *     which ISS-6463 made NOT NULL; the `sessionStartedAt` fallback that used to
 *     sit beside it covered pre-backfill rows that no longer exist.
 *  3. **No pending chunk** — `pendingChunkRevision` is null, so a session whose
 *     children are being rebuilt across transactions cannot be swept while its
 *     partial child table transiently presents the idle shape.
 *  4. **No pull request** — NOT `SESSION_HAS_PR_WHERE`. A session that produced
 *     a PR is meaningful even if its turn/token rollup reads zero, so it is
 *     spared unconditionally (belt-and-suspenders over the idle gate).
 *  5. **Synced-desktop origin** — the same `DESKTOP_SYNC` scope as the
 *     retention sweep (ISS-12435 remapped stored LOOP-origin rows to it).
 *  6. **No invocation generation, staged OR active** (ISS-5801, whitlockk on #6166).
 *     `component_invocation_count` is folded only at generation ACTIVATION, so
 *     while a multipart generation is still staged the parent presents the idle
 *     shape — and a historical-backlog session is aged on arrival. Sweeping it
 *     then would cascade the staged parts away and terminally re-orphan the
 *     later parts as `session_missing`. Any generation row is evidence of real
 *     work in flight (or landed), so its parent is never a phantom.
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
      { lastActivityAt: { lt: cutoff } },
      { NOT: SESSION_HAS_PR_WHERE },
      { pendingChunkRevision: null },
      // Condition 6 above: a staged (not-yet-active) generation keeps the
      // count at 0, so the idle predicate alone cannot see the in-flight work.
      { invocationGenerations: { none: {} } },
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
  /**
   * Rows the selection matched this batch. The loop terminates on THIS, not on
   * `deleted`: a candidate spared by the delete-time marker recheck (or taken by
   * an overlapping worker) makes `deleted` short of a full batch while more
   * candidates remain, and stopping on the delete count would leave them for the
   * next daily run. Mirrors `purgeIncompleteInvocationGenerationsBatch`.
   */
  candidateCount: number;
  /** Owning artifacts deleted this batch (cascades `SessionDetail`). */
  deleted: number;
  /** Session artifact ids whose deletion is proven by this batch's count. */
  deletedSessionIds: string[];
  /** False when concurrent deletion makes the exact deleted-id subset unknown. */
  deletedSessionIdsComplete: boolean;
  /** Transcript `objectStorageKey`s freed by this batch (S3 reclaim). */
  transcriptKeys: string[];
};

/**
 * Deletes up to `batchSize` phantom sessions by removing the owning artifact so
 * the cascade clears the `SessionDetail` row and its children — matching the
 * `purge-phantom-sessions` / retention convention. Re-evaluates candidates via
 * {@link phantomSessionWhere} on every call, so when run inside the delete
 * transaction a row that gained substantive activity (a late chunk) between two
 * calls is naturally re-excluded, and the DELETE re-checks `pendingChunkRevision`
 * so a chunk-0 apply committing inside the select→delete gap spares the row too.
 * Also reclaims each purged session's transcript archive keys, mirroring the
 * retention sweep.
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
    // ISS-10171: oldest-idle first, terminated by the primary key. `take`
    // without a total order leaves a page's MEMBERSHIP to the planner, so which
    // of the rows tied on `lastActivityAt` a page holds is undefined. It does
    // not strand them — this walk deletes what it serves, and a spared row is
    // excluded from the next selection by the `pendingChunkRevision: null`
    // predicate, so the population still shrinks to empty. What the total order
    // buys is a defined page and oldest-first drainage. `artifactId` is
    // `SessionDetail`'s `@id`, which makes the ordering total;
    // `@@index([lastActivityAt])` covers the leading key. Same shape as
    // `purgeIncompleteInvocationGenerationsBatch` in `retention-service.ts`;
    // ISS-10164 (PR #7217, still open) gives the expired-session walk beside it
    // the same treatment.
    orderBy: [{ lastActivityAt: "asc" }, { artifactId: "asc" }],
    take: batchSize,
  });
  if (phantoms.length === 0) {
    return {
      candidateCount: 0,
      deleted: 0,
      deletedSessionIds: [],
      deletedSessionIdsComplete: true,
      transcriptKeys: [],
    };
  }
  const artifactIds = phantoms.map((s) => s.artifactId);
  // Re-check the open-sequence marker inside the DELETE itself. `withDb.tx`
  // runs at READ COMMITTED, so a chunk-0 apply that commits between the
  // findMany above and this statement is already visible here; deleting by the
  // captured ids alone would cascade that freshly-pending session away despite
  // the guard in `phantomSessionWhere`.
  const result = await db.artifact.deleteMany({
    where: {
      id: { in: artifactIds },
      session: { is: { pendingChunkRevision: null } },
    },
  });
  const deletedSessionIdsComplete = result.count === artifactIds.length;
  const purged = await resolvePurgedCandidates(
    db,
    phantoms,
    deletedSessionIdsComplete
  );
  const transcriptKeys = await reclaimTranscriptArchives(db, purged);
  return {
    candidateCount: phantoms.length,
    deleted: result.count,
    deletedSessionIds: deletedSessionIdsComplete ? artifactIds : [],
    deletedSessionIdsComplete,
    transcriptKeys,
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
  ): Promise<PhantomSessionRetentionResult> {
    const cutoff = phantomCutoff(now, ageHours);
    let deleted = 0;
    let spared = 0;
    const deletedSessionIds: string[] = [];
    let deletedSessionIdsComplete = true;
    try {
      // Bounded per-batch transactions: each batch re-finds + deletes atomically
      // (so a session receiving a late substantive chunk mid-batch is re-excluded
      // and never purged half-substantive), and the loop converges a large idle
      // backlog across batches without one oversized transaction.
      for (;;) {
        const batch = await withDb.tx((tx) =>
          purgePhantomSessionsBatch(tx, cutoff, orgId)
        );
        deleted += batch.deleted;
        // ISS-10171: the shortfall is a REAL count, not an inference from a
        // number that happens to be small. A candidate this batch selected but
        // did not delete was spared by the delete-time `pendingChunkRevision`
        // recheck or taken by an overlapping sweep; either way the next run
        // re-evaluates it, and an operator watching this climb is watching
        // contention, not loss.
        spared += batch.candidateCount - batch.deleted;
        const remainingIdCapacity =
          MAX_LOGGED_PHANTOM_SESSION_IDS - deletedSessionIds.length;
        const batchIdsFit =
          batch.deletedSessionIds.length <= remainingIdCapacity;
        deletedSessionIdsComplete =
          deletedSessionIdsComplete &&
          batch.deletedSessionIdsComplete &&
          batchIdsFit;
        deletedSessionIds.push(
          ...batch.deletedSessionIds.slice(0, remainingIdCapacity)
        );
        // Reclaim transcript archives only AFTER the transaction commits, so a
        // storage failure is contained to logging and never rolls back the row
        // delete.
        await purgeTranscriptObjectsBestEffort(
          batch.transcriptKeys,
          "[cleanup-phantom-sessions] failed to purge transcript objects after phantom session delete",
          { cutoff: cutoff.toISOString() }
        );
        // Stop on the CANDIDATE count, never the delete count. A batch that
        // selected a full 500 and deleted 499 — one spared by the delete-time
        // marker recheck, or taken by an overlapping worker — still has more
        // candidates behind it, and breaking on `deleted` would strand them
        // until tomorrow's run.
        if (batch.candidateCount < SESSION_DELETE_BATCH_SIZE) {
          break;
        }
      }
      return {
        summary: `Deleted ${deleted} phantom desktop session(s) idle > ${ageHours}h (cutoff ${cutoff.toISOString()})`,
        cutoff: cutoff.toISOString(),
        retentionDays: ageHours / 24,
        deleted,
        spared,
        deletedSessionIds,
        deletedSessionIdsComplete,
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[cleanup-phantom-sessions] phantom sweep failed", {
        error: message,
        ageHours,
        cutoff: cutoff.toISOString(),
        deleted,
        spared,
        deletedSessionIds,
        deletedSessionIdsComplete,
      });
      let summary = `Phantom session sweep failed: ${message}`;
      if (deleted > 0) {
        summary = `Phantom session sweep failed after deleting ${deleted} session(s): ${message}`;
      }
      return {
        summary,
        cutoff: cutoff.toISOString(),
        retentionDays: ageHours / 24,
        deleted,
        spared,
        deletedSessionIds,
        deletedSessionIdsComplete,
        exitCode: 1,
      };
    }
  },
};

export type PhantomSessionRetentionResult = SessionRetentionResult & {
  /**
   * Candidates this sweep selected but did not delete, summed over its batches
   * (ISS-10171). A spared candidate is contention — the delete-time
   * `pendingChunkRevision` recheck kept it, or an overlapping sweep took it —
   * never a lost row: the loop already advances on candidates seen, and the
   * next run re-evaluates whatever is left.
   */
  spared: number;
  deletedSessionIds: string[];
  /** False when contention or the 100-id log cap makes the list incomplete. */
  deletedSessionIdsComplete: boolean;
};

const MAX_LOGGED_PHANTOM_SESSION_IDS = 100;

type PhantomCandidate = {
  artifactId: string;
  computeTargetId: string;
  externalSessionId: string;
};

/**
 * Narrows a batch's selected candidates to the ones the DELETE actually removed.
 * The delete-time `pendingChunkRevision` recheck (or a concurrent sweep) can
 * spare a candidate, and a spared row keeps its `SessionDetail`, so re-reading
 * the selection names the survivors exactly.
 *
 * ISS-10171: this read deliberately carries no ordering. It is a bounded lookup
 * over the exact id set the batch already selected — no `take`, no page
 * boundary — and its result is consumed only as a membership set, so row order
 * cannot change the answer. The exactly-once hazard an ordering fixes belongs
 * to the paged candidate walk above, not here.
 */
async function resolvePurgedCandidates(
  db: DbClient,
  phantoms: PhantomCandidate[],
  allDeleted: boolean
): Promise<PhantomCandidate[]> {
  if (allDeleted) {
    return phantoms;
  }
  const survivors = await db.sessionDetail.findMany({
    where: { artifactId: { in: phantoms.map((s) => s.artifactId) } },
    select: { artifactId: true },
  });
  const spared = new Set(survivors.map((s) => s.artifactId));
  return phantoms.filter((s) => !spared.has(s.artifactId));
}

/**
 * Drops the `SessionTranscript` rows owned by the sessions this batch removed and
 * returns their S3 keys for reclaim. Runs AFTER the artifact delete so a spared
 * session never loses its transcript: `SessionTranscript` carries its own
 * `(computeTargetId, externalSessionId)` identity, so the rows stay findable once
 * the `SetNull` FK clears.
 */
async function reclaimTranscriptArchives(
  db: DbClient,
  purged: PhantomCandidate[]
): Promise<string[]> {
  if (purged.length === 0) {
    return [];
  }
  // ISS-8200: the same stored-vs-raw identity mismatch `retention-service.ts`
  // documents — `s.externalSessionId` came out of `SessionDetail` (projected
  // since ISS-8069) while a pre-ISS-8125 `SessionTranscript` row still holds the
  // raw value, so a plain equality `OR` reclaims neither the rows nor their S3
  // archives.
  const identityWhere: Prisma.SessionTranscriptWhereInput = {
    OR: purged.map((s) => ({
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
    where: identityWhere,
    select: { objectStorageKey: true },
  });
  await db.sessionTranscript.deleteMany({ where: identityWhere });
  return transcripts
    .map((t) => t.objectStorageKey)
    .filter((key): key is string => key.length > 0);
}
