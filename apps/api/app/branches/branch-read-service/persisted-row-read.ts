import { ArtifactType, type Prisma, type PrismaClient } from "@repo/database";
import { isOrgScopeOwned, resolveOrgScope } from "@/lib/org-scope";
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

export type BranchArtifactRow = SelectedBranchArtifact & {
  branch: NonNullable<SelectedBranchArtifact["branch"]>;
};

export type BranchDetailArtifactRow = SelectedBranchDetailArtifact & {
  branch: NonNullable<SelectedBranchDetailArtifact["branch"]>;
};

type PersistedBranchReadClient = Pick<PrismaClient, "$queryRaw" | "artifact">;

/** Hydrate list rows while retaining exact candidate order and activity evidence. */
export async function getBranchRowsById(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchIds: string[],
  candidates?: readonly BranchCandidateSnapshot[]
): Promise<BranchArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  const rows = await db.artifact.findMany({
    where: {
      id: { in: branchIds },
      organizationId,
      type: ArtifactType.BRANCH,
      branch: { deletedAt: null },
    },
    select: branchArtifactSelectForOrganization(organizationId),
  });
  const candidatesById = indexBranchCandidateSnapshots(candidates);
  const rowsById = new Map(
    rows
      .filter(hasBranchArtifactRow)
      .map((row) => [
        row.id,
        applyBranchCandidateActivitySnapshot(row, candidatesById),
      ])
  );
  return branchIds.flatMap((branchId) => {
    const row = rowsById.get(branchId);
    return row ? [row] : [];
  });
}

/** Hydrate analytics rows with activity from the same candidate snapshot. */
export async function getBranchAnalyticsRows(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchIds: string[],
  candidates?: readonly BranchCandidateSnapshot[]
): Promise<BranchAnalyticsArtifactRow[]> {
  if (branchIds.length === 0) {
    return [];
  }
  const rows = await db.artifact.findMany({
    where: {
      id: { in: branchIds },
      organizationId,
      type: ArtifactType.BRANCH,
      branch: { deletedAt: null },
    },
    select: branchAnalyticsSelect,
  });
  const candidatesById = indexBranchCandidateSnapshots(candidates);
  return rows
    .filter(hasBranchAnalyticsRow)
    .map((row) => applyBranchCandidateActivitySnapshot(row, candidatesById));
}

/** Resolve one organization-owned detail row and its candidate-selected atom. */
export async function findBranchArtifact(
  db: PersistedBranchReadClient,
  organizationId: string,
  branchId: string
): Promise<BranchDetailArtifactRow | null> {
  const [candidate] = await getBranchCandidateSnapshots(
    db,
    organizationId,
    { limit: 1, offset: 0 },
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
  return applyBranchCandidateActivitySnapshot(
    scoped.value,
    new Map([[candidate.id, candidate]])
  );
}

function branchWhere(
  organizationId: string,
  branchId: string
): Prisma.ArtifactWhereInput {
  return {
    id: branchId,
    organizationId,
    type: ArtifactType.BRANCH,
    branch: { deletedAt: null },
  };
}

function hasBranchArtifactRow(
  row: SelectedBranchArtifact | null
): row is BranchArtifactRow {
  return Boolean(row?.branch);
}

function hasBranchDetailArtifactRow(
  row: SelectedBranchDetailArtifact | null
): row is BranchDetailArtifactRow {
  return Boolean(row?.branch);
}
