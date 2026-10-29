import type { BranchCommit } from "@repo/api/src/types/branch";
import { ArtifactType, type Prisma, type PrismaClient } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import { isOrgScopeOwned, resolveOrgScope } from "@/lib/org-scope";
import type { CanonicalCloudBranchActivityAtom } from "../branch-activity-canonical-read";
import {
  type BranchAnalyticsArtifactRow,
  branchAnalyticsSelect,
  hasBranchAnalyticsRow,
} from "../branch-analytics-select";
import {
  applyBranchCandidateActivitySnapshot,
  type BranchCandidateSnapshot,
  getBranchCandidateSnapshots,
  indexBranchCandidateSnapshots,
} from "../branch-candidate-read";
import {
  branchArtifactSelectForOrganization,
  branchDetailArtifactSelectForOrganization,
  type SelectedBranchArtifact,
  type SelectedBranchDetailArtifact,
} from "../branch-read-selects";
import {
  type BranchFileChangeTotals,
  EMPTY_BRANCH_FILE_CHANGE_TOTALS,
  getBranchFileChangeTotals,
} from "./file-change-totals-read";
import { toIso } from "./session-usage-window";

/** A selected list row proven to carry its branch relation, pre-hydration. */
type BranchArtifactRowWithBranch = SelectedBranchArtifact & {
  branch: NonNullable<SelectedBranchArtifact["branch"]>;
};

/** @see BranchAnalyticsArtifactRow — same ISS-8016 split, list path. */
export type BranchArtifactRow = BranchArtifactRowWithBranch & {
  branch: BranchArtifactRowWithBranch["branch"] & {
    activityAtoms: CanonicalCloudBranchActivityAtom[];
    fileChangeTotals: BranchFileChangeTotals;
  };
};

/** A selected detail row proven to carry its branch relation, pre-hydration. */
type BranchDetailArtifactRowWithBranch = SelectedBranchDetailArtifact & {
  branch: NonNullable<SelectedBranchDetailArtifact["branch"]>;
};

/** @see BranchAnalyticsArtifactRow — same ISS-8016 split, detail path. */
export type BranchDetailArtifactRow = BranchDetailArtifactRowWithBranch & {
  branch: BranchDetailArtifactRowWithBranch["branch"] & {
    activityAtoms: CanonicalCloudBranchActivityAtom[];
    fileChangeTotals: BranchFileChangeTotals;
  };
};

type PersistedBranchReadClient = Pick<
  PrismaClient,
  "$queryRaw" | "artifact" | "branchFileChange"
>;

/** Hydrate list rows while retaining exact candidate order and activity evidence. */
export async function getBranchRowsById(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchIds: string[],
  candidates: readonly BranchCandidateSnapshot[]
): Promise<BranchArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  // The fold is keyed off `branchIds`, which is known before either read runs,
  // so it is issued CONCURRENTLY with the hydration rather than after it
  // (`apps/api/AGENTS.md` → Query Shape and Route Gates).
  const [rows, totalsByBranch] = await Promise.all([
    hydrateArtifactChunks(branchIds, (ids) =>
      db.artifact.findMany({
        where: branchRowsWhere(organizationId, ids),
        select: branchArtifactSelectForOrganization(organizationId),
      })
    ),
    getBranchFileChangeTotals(db, organizationId, branchIds),
  ]);
  const candidatesById = indexBranchCandidateSnapshots(candidates);
  return selectRowsInIdOrder(
    rows
      .filter(hasBranchArtifactRow)
      .map((row) => applyBranchCandidateActivitySnapshot(row, candidatesById))
      .map((row) => applyBranchFileChangeTotals(row, totalsByBranch)),
    branchIds
  );
}

/** Hydrate analytics rows with activity from the same candidate snapshot. */
export async function getBranchAnalyticsRows(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchIds: string[],
  candidates: readonly BranchCandidateSnapshot[]
): Promise<BranchAnalyticsArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  const [hydrated, totalsByBranch] = await Promise.all([
    hydrateArtifactChunks(branchIds, (ids) =>
      db.artifact.findMany({
        where: branchRowsWhere(organizationId, ids),
        select: branchAnalyticsSelect,
      })
    ),
    getBranchFileChangeTotals(db, organizationId, branchIds),
  ]);
  const rows = hydrated.filter(hasBranchAnalyticsRow);
  const candidatesById = indexBranchCandidateSnapshots(candidates);
  return selectRowsInIdOrder(
    rows
      .map((row) => applyBranchCandidateActivitySnapshot(row, candidatesById))
      .map((row) => applyBranchFileChangeTotals(row, totalsByBranch)),
    branchIds
  );
}

/**
 * Resolve one organization-owned detail row and its candidate-selected atom.
 *
 * The snapshot is CONFIRMED after the artifact read, not reused from before it.
 * `branchWhere` only proves the row still exists and is owned; it says nothing
 * about Product eligibility or which activity atom is now canonical, so without
 * the second read an eligibility revoked — or an atom superseded — while the
 * artifact read ran would still be served as admitted state (ISS-9111 review).
 *
 * Both reads share ONE pinned `evaluationNow`. That is what keeps the
 * confirmation honest: left to default its own clock it would re-evaluate the
 * candidate against a different instant than the read that admitted it, so a
 * disagreement could mean either revocation or merely a later `now`.
 */
export async function findBranchArtifact(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchId: string
): Promise<BranchDetailArtifactRow | null> {
  const query = { limit: 1, offset: 0, evaluationNow: new Date() };
  const [candidate] = await getBranchCandidateSnapshots(
    db,
    organizationId,
    query,
    [branchId]
  );
  if (!candidate) {
    return null;
  }
  const row = await db.artifact.findFirst({
    where: branchWhere(organizationId, branchId),
    select: branchDetailArtifactSelectForOrganization(organizationId),
  });
  if (!hasBranchDetailArtifactRow(row)) {
    return null;
  }
  const scoped = resolveOrgScope(organizationId, row);
  if (!isOrgScopeOwned(scoped)) {
    return null;
  }
  const [confirmedCandidate] = await getBranchCandidateSnapshots(
    db,
    organizationId,
    query,
    [branchId]
  );
  if (!confirmedCandidate) {
    return null;
  }
  return applyBranchFileChangeTotals(
    applyBranchCandidateActivitySnapshot(
      scoped.value,
      new Map([[confirmedCandidate.id, confirmedCandidate]])
    ),
    await getBranchFileChangeTotals(db, organizationId, [branchId])
  );
}

/**
 * The rows for `ids`, in `ids` order, silently dropping an id with no row. Every
 * by-id branch read owes its caller the candidate order it asked in, and an id
 * whose row the org does not own must vanish rather than surface as a hole.
 */
export function selectRowsInIdOrder<Row extends { id: string }>(
  rows: readonly Row[],
  ids: readonly string[]
): Row[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });
}

function branchWhere(
  organizationId: string,
  branchId: string
): Prisma.ArtifactWhereInput {
  return {
    id: branchId,
    organizationId,
    type: ArtifactType.BRANCH,
    branch: { isNot: null },
  };
}

function hasBranchArtifactRow(
  row: SelectedBranchArtifact | null
): row is BranchArtifactRowWithBranch {
  return Boolean(row?.branch);
}

function hasBranchDetailArtifactRow(
  row: SelectedBranchDetailArtifact | null
): row is BranchDetailArtifactRowWithBranch {
  return Boolean(row?.branch);
}

export const BRANCH_ROW_HYDRATION_BATCH_SIZE = 2000;

/** The org-scoped, non-deleted branch rows for one id chunk. */
function branchRowsWhere(
  organizationId: string,
  ids: readonly string[]
): Prisma.ArtifactWhereInput {
  return {
    id: { in: [...ids] },
    organizationId,
    type: ArtifactType.BRANCH,
    branch: { isNot: null },
  };
}

/**
 * Run `read` over the id list in bind-parameter-bounded chunks, concurrently.
 * Chunk order is irrelevant: every caller re-sorts through
 * {@link selectRowsInIdOrder} against the candidate order it asked in.
 */
async function hydrateArtifactChunks<Row>(
  branchIds: readonly string[],
  read: (ids: readonly string[]) => Promise<Row[]>
): Promise<Row[]> {
  const chunks = await Promise.all(
    chunksOf(branchIds, BRANCH_ROW_HYDRATION_BATCH_SIZE).map(read)
  );
  return chunks.flat();
}

/**
 * Serve an already-hydrated list row as its analytics row.
 *
 * ISS-9111: the identity body is the guard — it compiles only while the list
 * select stays a superset of the analytics select, so widening
 * `branchAnalyticsSelect` fails `tsc` here. ISS-10298 removed the one part the
 * compiler could not see: the `fileChanges` relation and its `take` are gone
 * from both selects, and `fileChangeTotals` is attached post-hydration on both
 * paths from the same fold, so the superset relation is now fully type-checked.
 */
export function asBranchAnalyticsRow(
  row: BranchArtifactRow
): BranchAnalyticsArtifactRow {
  return row;
}

/**
 * The branch's real git commits for the PRD-486 activity rail, read from the
 * persisted CommitDetail SSOT (PRD-510 D7) — the SAME data the desktop producer
 * captures event-time — mapped oldest-first to the wire `BranchCommit`. Scoped by
 * `branchArtifactId` alone, per the CommitDetail D4 rule that reads reach the row
 * through its (already org-verified) branch, not via `organizationId` (which the
 * schema documents as a dedup-only, non-query-scoping column). The sole caller
 * resolves the branch through the `findBranchArtifact` org-scope seam first, so
 * the branch id is already proven org-owned before this read runs. A row with no
 * `committedAt` cannot be positioned on the rail, so it is dropped rather than
 * shipped with a fabricated instant. Sorted defensively (the read already orders
 * by committedAt) to mirror the desktop producer's explicit rail sort
 * (shared-branches-api.ts).
 */
export async function getBranchCommits(
  db: Pick<PrismaClient, "commitDetail">,
  branchArtifactId: string
): Promise<BranchCommit[]> {
  const rows = await db.commitDetail.findMany({
    where: { branchArtifactId },
    orderBy: { committedAt: "asc" },
    select: { sha: true, committedAt: true, message: true },
  });
  return rows
    .filter(
      (row): row is typeof row & { committedAt: Date } =>
        row.committedAt !== null
    )
    .sort((a, b) => a.committedAt.getTime() - b.committedAt.getTime())
    .map((row) => ({
      sha: row.sha,
      committedAt: toIso(row.committedAt),
      message: row.message ?? "",
    }));
}

/**
 * ISS-10298: attach the database-folded file-cache diff totals, the SOLE source
 * of `branch.fileChangeTotals` on the list, detail, and analytics paths — their
 * selects no longer load the per-file rows, because three numbers were the only
 * thing any of them read out of up to 500 rows per branch.
 *
 * A branch with no group in the fold has no cached file changes at all, which is
 * unavailable LOC rather than a zero total — so it takes
 * {@link EMPTY_BRANCH_FILE_CHANGE_TOTALS}, which `currentFileTotals` resolves to
 * all-null exactly as an empty row set did.
 */
function applyBranchFileChangeTotals<
  Row extends { id: string; branch: object },
>(
  row: Row,
  totalsByBranch: ReadonlyMap<string, BranchFileChangeTotals>
): Row & {
  branch: Row["branch"] & { fileChangeTotals: BranchFileChangeTotals };
} {
  return {
    ...row,
    branch: {
      ...row.branch,
      fileChangeTotals:
        totalsByBranch.get(row.id) ?? EMPTY_BRANCH_FILE_CHANGE_TOTALS,
    },
  };
}
