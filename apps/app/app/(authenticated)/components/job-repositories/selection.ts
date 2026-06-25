import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import {
  RepoSource,
  type ResolvedRepo,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import type { TeamRepoWithTeamId } from "@repo/app/teams/hooks/use-team-repositories-union";

export type JobRepoSelection = {
  primary: { id: string; fullName: string; branch: string };
  additional: AdditionalRepoRef[];
};

export type ComputeIncompleteArgs = {
  requirePrimary: boolean;
  primaryId: string | null;
  selectedIds: Set<string>;
  pool: TeamRepoWithTeamId[];
  branchByRepoId: Record<string, string>;
};

export function computeIncomplete({
  requirePrimary,
  primaryId,
  selectedIds,
  pool,
  branchByRepoId,
}: ComputeIncompleteArgs): boolean {
  if (!requirePrimary) {
    return false;
  }
  if (!primaryId) {
    return true;
  }
  if (!selectedIds.has(primaryId)) {
    return true;
  }
  // No global `isLoadingBranches` gate — the per-id `branchByRepoId` check
  // below already returns "incomplete" while a fetch is in flight, and
  // returns "complete" the instant a row's branch resolves (whether from
  // the seed or the GitHub fetch). Using the global flag would needlessly
  // block submit in the all-seeded case where every selected row already
  // has a branch on first render.
  const poolIdSet = new Set(pool.map((r) => r.installationRepositoryId));
  for (const id of selectedIds) {
    if (!poolIdSet.has(id)) {
      return true;
    }
    if (!branchByRepoId[id]) {
      return true;
    }
  }
  return false;
}

export type BuildSelectionArgs = {
  pool: TeamRepoWithTeamId[];
  primaryId: string | null;
  selectedIds: Set<string>;
  branchByRepoId: Record<string, string>;
};

export function buildSelection({
  pool,
  primaryId,
  selectedIds,
  branchByRepoId,
}: BuildSelectionArgs): JobRepoSelection | null {
  if (!primaryId) {
    return null;
  }
  const primaryRepo = pool.find(
    (r) => r.installationRepositoryId === primaryId
  );
  const primaryBranch = branchByRepoId[primaryId];
  if (!(primaryRepo && primaryBranch)) {
    return null;
  }
  const primary: ResolvedRepo & { branch: string } = {
    id: primaryRepo.installationRepositoryId,
    fullName: primaryRepo.repository.fullName,
    branch: primaryBranch,
    source: RepoSource.TeamDefault,
    inPool: true,
  };
  const additional: AdditionalRepoRef[] = [];
  for (const id of selectedIds) {
    if (id === primaryId) {
      continue;
    }
    const repo = pool.find((r) => r.installationRepositoryId === id);
    const branch = branchByRepoId[id];
    if (!(repo && branch)) {
      continue;
    }
    additional.push({
      fullName: repo.repository.fullName,
      branch,
    });
  }
  return {
    primary: {
      id: primary.id,
      fullName: primary.fullName,
      branch: primary.branch,
    },
    additional,
  };
}
