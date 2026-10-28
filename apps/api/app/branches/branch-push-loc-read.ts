import { BranchActivitySource } from "@repo/api/src/types/branch-activity";
import type { TransactionClient } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import {
  getPrismaDriverAdapterSqlState,
  getPrismaErrorCode,
} from "@/lib/db-utils";
import {
  type BranchListEnrichmentDomain,
  BranchListEnrichmentRead,
  markBranchListEnrichmentUnavailable,
  reportBranchListEnrichmentFailedOpen,
} from "./branch-list-enrichment";
import { BRANCH_ROW_HYDRATION_BATCH_SIZE } from "./branch-read-service/persisted-row-read";

/** One captured push's own LOC delta and the sha range it describes. */
export type BranchPushLocAtom = {
  branchArtifactId: string;
  sourceEventId: string;
  /**
   * The push's own occurrence time — the newest `commits[].timestamp`, which is
   * a git AUTHOR date the client controls (ISS-10009 ruling 1's caveat). It is
   * what a window must place a push by, and it is NOT comparable against a
   * server clock: a rebase or amend carries an old author date onto a new push.
   */
  occurredAt: Date;
  /** When this row was written. Server-side, so capture START is measurable. */
  createdAt: Date;
  beforeSha: string;
  afterSha: string;
  linesAdded: number | null;
  linesRemoved: number | null;
};

/** A captured push this read could not use, still placeable in a window. */
export type UnusableBranchPushLocAtom = {
  branchArtifactId: string;
  sourceEventId: string;
  occurredAt: Date;
};

export type BranchPushLocEvidence = {
  byBranchId: ReadonlyMap<string, readonly BranchPushLocAtom[]>;
  /**
   * Captured pushes dropped for a missing sha range. Carried rather than
   * discarded so the projection can disclose them: a silently dropped push
   * makes a branch read Complete while its lines are missing.
   */
  unusableByBranchId: ReadonlyMap<string, readonly UnusableBranchPushLocAtom[]>;
  /** Branches whose chunk filled the remaining budget, or was not read. */
  truncatedBranchIds: ReadonlySet<string>;
};

/** The answer for a cohort with nothing captured — and for a failed read. */
export const EMPTY_BRANCH_PUSH_LOC_EVIDENCE: BranchPushLocEvidence = {
  byBranchId: new Map(),
  unusableByBranchId: new Map(),
  truncatedBranchIds: new Set(),
};

/**
 * Bind-parameter bound on the id predicate, also limiting the branches that
 * inherit uncertainty when a chunk fills the remaining shared row budget.
 * The read runs on the snapshot's one connection, so each chunk is a
 * sequential round trip: 200 ids was 19 of them for 3,665 branches (ISS-12346).
 */
export const BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE =
  BRANCH_ROW_HYDRATION_BATCH_SIZE;
/**
 * Request-wide transport ceiling (Perrin's 2026-09-18 ruling). No per-branch
 * floor: a long history can exhaust this shared budget. There is no extra
 * lookahead row; filling the budget discloses uncertainty conservatively.
 */
export const BRANCH_PUSH_LOC_ATOM_READ_MAX = 20_000;

type BranchPushLocAtomClient = Pick<TransactionClient, "branchActivityAtom">;

/**
 * Read the per-push LOC atoms ISS-10009 part 1 captures for a branch cohort.
 *
 * Deliberately NOT the canonical activity read: `canonicalBranchActivitySources`
 * excludes `push_loc` so a push cannot set Last-active, and that read takes the
 * single latest atom. This one wants every push, which is the whole point of a
 * windowed total.
 *
 * Deliberately UNWINDOWED too, though every list consumer is windowed. The
 * Branch detail fold is lifetime-scoped, and `preCapturePushGap` decides its
 * disclosure from the branch's EARLIEST captured push — both read atoms outside
 * the request window, so a date predicate here would silently drop the rows
 * that prove coverage. The bound is the row cap, not the window.
 */
export async function loadBranchPushLocAtoms(
  db: BranchPushLocAtomClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<BranchPushLocEvidence> {
  if (branchIds.length === 0) {
    return EMPTY_BRANCH_PUSH_LOC_EVIDENCE;
  }
  const byBranchId = new Map<string, BranchPushLocAtom[]>();
  const unusableByBranchId = new Map<string, UnusableBranchPushLocAtom[]>();
  const truncatedBranchIds = new Set<string>();
  let remaining = BRANCH_PUSH_LOC_ATOM_READ_MAX;
  for (const ids of chunksOf(
    [...branchIds],
    BRANCH_PUSH_LOC_ATOM_ID_CHUNK_SIZE
  )) {
    const rows =
      remaining === 0
        ? []
        : await db.branchActivityAtom.findMany({
            where: {
              organizationId,
              branchArtifactId: { in: ids },
              source: BranchActivitySource.PushLoc,
              compatibilityAliasForSourceEventId: null,
            },
            select: {
              branchArtifactId: true,
              sourceEventId: true,
              occurredAt: true,
              createdAt: true,
              beforeSha: true,
              afterSha: true,
              linesAdded: true,
              linesRemoved: true,
            },
            // Keep the newest captures within each read chunk. The server write
            // clock, unlike a client-controlled commit date, cannot be back-dated
            // by a rebase. Consumers still receive occurrence order below.
            orderBy: [{ createdAt: "desc" }, { sourceEventId: "desc" }],
            take: remaining,
          });
    // Without an extra probe, a full chunk cannot prove it read every row.
    // A zero remaining budget also marks every unread chunk (0 === 0).
    // Its branches and all later unread chunks disclose Partial; completed
    // earlier chunks retain their own coverage verdict.
    if (rows.length === remaining) {
      for (const id of ids) {
        truncatedBranchIds.add(id);
      }
    }
    remaining -= rows.length;
    for (const row of rows) {
      const atom = toBranchPushLocAtom(row);
      if (atom) {
        appendTo(byBranchId, atom.branchArtifactId, atom);
        continue;
      }
      const unusable = toUnusableBranchPushLocAtom(row);
      if (unusable) {
        appendTo(unusableByBranchId, unusable.branchArtifactId, unusable);
      }
    }
  }
  // The read is newest-CAPTURED first for the cap; consumers want occurrence
  // order, which is what places a push in a window.
  for (const atoms of byBranchId.values()) {
    atoms.sort(compareByOccurrence);
  }
  return { byBranchId, unusableByBranchId, truncatedBranchIds };
}

/**
 * {@link loadBranchPushLocAtoms}, failing OPEN.
 *
 * This read enriches the LOC cards; it must not discard a response whose rows
 * and base KPIs already computed (apps/api/AGENTS.md, "Optional enrichment must
 * not sit on a fatal path"). Degrading to empty evidence is honest rather than
 * silent — every branch with a `firstPushedAt` then raises its uncaptured-push
 * gap, so the cards disclose instead of publishing a total built on nothing.
 *
 * The failure is reported through the enrichment reporter the list reads
 * already use, so it lands on the SAME monitored event rather than a second one
 * nothing watches: a persistent defect here would otherwise return empty
 * evidence forever, which the cards render exactly like a cohort that has
 * genuinely captured nothing yet.
 *
 * Only for a read with no shared transaction (the Branch detail). Inside a
 * read snapshot use {@link loadBranchPushLocAtomsInSnapshot}: a statement
 * PostgreSQL aborts there takes every sibling read down with it.
 */
export function loadBranchPushLocAtomsFailingOpen(
  db: BranchPushLocAtomClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<BranchPushLocEvidence> {
  return loadBranchPushLocAtoms(db, organizationId, branchIds).catch(
    (error: unknown) => {
      reportBranchListEnrichmentFailedOpen(
        BranchListEnrichmentRead.PushLoc,
        error,
        { organizationId, rowCount: branchIds.length }
      );
      return EMPTY_BRANCH_PUSH_LOC_EVIDENCE;
    }
  );
}

/**
 * {@link loadBranchPushLocAtoms} inside a `readBranchListFailingOpen` snapshot
 * (ISS-10804).
 *
 * A database failure is recorded and RETHROWN, never absorbed. Once PostgreSQL
 * aborts the snapshot on this statement nothing else in it can be read, and
 * absorbing the error would leave recovery to the siblings rejecting — which
 * Prisma does not guarantee: measured on 7.10 with the pg adapter, a
 * nested-select `findMany` on the aborted transaction resolves `undefined`, and
 * its COMMIT resolves. Rethrowing makes `readBranchListFailingOpen` re-run the
 * snapshot with this read skipped.
 *
 * A throw carrying neither a Prisma code nor a driver SQLSTATE never reached
 * PostgreSQL (a TypeError in the row mapping), so the snapshot is still healthy:
 * it is recorded and degraded in place, as `runBranchListEnrichmentRead` does,
 * rather than doubling the snapshot on every request (#8138 review, tamsinb).
 *
 * A snapshot that failed elsewhere is left unrecorded, so it rethrows without a
 * retry: P2028 (expired) for the reason `readBranchServerPageFromSql` gives, and
 * 25P02, where another read already aborted the snapshot and this one was only
 * queued behind it. Skipping this read cannot fix either, and recording them
 * would blame push LOC and buy a second full-corpus attempt for a core failure.
 */
export async function loadBranchPushLocAtomsInSnapshot(
  db: BranchPushLocAtomClient,
  organizationId: string,
  branchIds: readonly string[],
  enrichment: BranchListEnrichmentDomain
): Promise<BranchPushLocEvidence> {
  if (enrichment.skip.has(BranchListEnrichmentRead.PushLoc)) {
    return EMPTY_BRANCH_PUSH_LOC_EVIDENCE;
  }
  try {
    return await loadBranchPushLocAtoms(db, organizationId, branchIds);
  } catch (error) {
    const prismaCode = getPrismaErrorCode(error);
    const sqlState = getPrismaDriverAdapterSqlState(error);
    const failedElsewhere = prismaCode === "P2028" || sqlState === "25P02";
    if (!failedElsewhere) {
      markBranchListEnrichmentUnavailable({
        read: BranchListEnrichmentRead.PushLoc,
        domain: enrichment,
        context: { organizationId, rowCount: branchIds.length },
        error,
      });
    }
    if (prismaCode === undefined && sqlState === undefined) {
      return EMPTY_BRANCH_PUSH_LOC_EVIDENCE;
    }
    throw error;
  }
}

function appendTo<Value>(
  target: Map<string, Value[]>,
  key: string,
  value: Value
): void {
  const existing = target.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  target.set(key, [value]);
}

/**
 * A captured push we cannot place on a sha range, kept only so the projection
 * can disclose it. Dropped outright when even its instant is unusable — there
 * is then nothing to stamp a coverage gap with.
 */
function toUnusableBranchPushLocAtom(row: {
  branchArtifactId: string;
  sourceEventId: string;
  occurredAt: Date;
}): UnusableBranchPushLocAtom | null {
  if (!Number.isFinite(row.occurredAt.getTime())) {
    return null;
  }
  return {
    branchArtifactId: row.branchArtifactId,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt,
  };
}

function compareByOccurrence(
  left: BranchPushLocAtom,
  right: BranchPushLocAtom
): number {
  const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return left.sourceEventId.localeCompare(right.sourceEventId);
}

/**
 * Attach one cohort's captured push evidence to the rows that project LOC.
 *
 * Mirrors `applyBranchCandidateActivitySnapshot`: generic over the row so this
 * module stays a leaf, and required-argument so this helper cannot be called
 * without the read that fills it. It does NOT stop a future metric call site
 * from skipping the helper entirely — the row fields are optional so existing
 * fixtures still compile — and such a caller silently gets the no-capture
 * answer. `branch-read-service.push-loc-wiring.test.ts` is what pins all three
 * production paths against that, each seeding a real atom because on an empty
 * capture the output is identical whether this ran or not.
 */
export function withBranchPushLocEvidence<
  Row extends { id: string; branch: object },
>(
  rows: readonly Row[],
  evidence: BranchPushLocEvidence
): (Row & {
  branch: Row["branch"] & {
    pushLocAtoms: readonly BranchPushLocAtom[];
    unusablePushLocAtoms: readonly UnusableBranchPushLocAtom[];
    pushLocEvidenceTruncated: boolean;
  };
})[] {
  return rows.map((row) => ({
    ...row,
    branch: {
      ...row.branch,
      pushLocAtoms: evidence.byBranchId.get(row.id) ?? [],
      unusablePushLocAtoms: evidence.unusableByBranchId.get(row.id) ?? [],
      pushLocEvidenceTruncated: evidence.truncatedBranchIds.has(row.id),
    },
  }));
}

function toBranchPushLocAtom(row: {
  branchArtifactId: string;
  sourceEventId: string;
  occurredAt: Date;
  createdAt: Date;
  beforeSha: string | null;
  afterSha: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
}): BranchPushLocAtom | null {
  if (
    row.beforeSha === null ||
    row.afterSha === null ||
    !(
      Number.isFinite(row.occurredAt.getTime()) &&
      Number.isFinite(row.createdAt.getTime())
    )
  ) {
    return null;
  }
  return {
    branchArtifactId: row.branchArtifactId,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
    beforeSha: row.beforeSha,
    afterSha: row.afterSha,
    linesAdded: row.linesAdded,
    linesRemoved: row.linesRemoved,
  };
}
