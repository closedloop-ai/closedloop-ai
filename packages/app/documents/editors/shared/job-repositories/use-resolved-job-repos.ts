"use client";

import {
  getProjectSettings,
  type ProjectSettings,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { useProject } from "@repo/app/projects/hooks/use-projects";
import {
  type TeamRepoWithTeamId,
  useTeamRepositoriesUnion,
} from "@repo/app/teams/hooks/use-team-repositories-union";
import { useMemo } from "react";

export const RepoSource = {
  ProjectOverride: "project-override",
  TeamDefault: "team-default",
  // Repo the user manually included in the picker; not seeded by the
  // resolver. Labeled separately so the row doesn't claim to come from team
  // defaults when it doesn't.
  UserAdded: "user-added",
} as const;
export type RepoSource = (typeof RepoSource)[keyof typeof RepoSource];

// Pool repos identify by `installationRepositoryId`.
export type ResolvedRepo = {
  id: string;
  fullName: string;
  source: RepoSource;
};

export type UseResolvedJobReposResult = {
  primary: ResolvedRepo | null;
  additional: ResolvedRepo[];
  pool: TeamRepoWithTeamId[];
  isLoading: boolean;
  // Why the pool is empty, when it is empty because the read FAILED (ISS-5095).
  // Without this the resolver hands consumers an empty `pool` and they render
  // "No repositories curated on this project's team" — a claim about the team's
  // configuration that the code has no evidence for, pointing the user at a
  // settings page to fix something that isn't broken. `null` when the reads
  // succeeded, in which case an empty pool really is empty.
  poolError: string | null;
};

export type UseResolvedJobReposArgs = {
  projectId: string | null | undefined;
  enabled?: boolean;
};

// Composes the resolution chain (project override > single-team inheritance)
// plus per-repo source labels. The result is the seed state for
// `JobRepositoriesSection`; user edits inside the section override these
// values without writing them back to the project or team.
export function useResolvedJobRepos({
  projectId,
  enabled = true,
}: UseResolvedJobReposArgs): UseResolvedJobReposResult {
  const projectQueryEnabled = enabled && Boolean(projectId);
  const { data: projectData, isLoading: isLoadingProject } = useProject(
    projectId ?? "",
    { enabled: projectQueryEnabled }
  );

  const teamIds = useMemo(
    () => projectData?.teams.map((t) => t.id) ?? [],
    [projectData?.teams]
  );
  const {
    repositories: pool,
    isLoading: isLoadingPool,
    error: poolError,
  } = useTeamRepositoriesUnion({
    teamIds,
    enabled: enabled && teamIds.length > 0,
  });

  const projectSettings: ProjectSettings = useMemo(
    () => getProjectSettings(projectData?.settings ?? {}),
    [projectData?.settings]
  );

  const resolved = useMemo(() => {
    if (!projectData) {
      return null;
    }
    return resolveProjectRepoDefaults({
      projectSettings,
      teamRepos: pool.map((r) => ({
        installationRepositoryId: r.installationRepositoryId,
        isDefaultSelected: r.isDefaultSelected,
        isPrimary: r.isPrimary,
      })),
      teamCount: teamIds.length,
    });
  }, [projectData, projectSettings, pool, teamIds.length]);

  const projectPrimarySource: RepoSource | null = useMemo(
    () => determineProjectPrimarySource(projectSettings, teamIds.length),
    [projectSettings, teamIds.length]
  );

  const result = useMemo<UseResolvedJobReposResult>(() => {
    const isLoading = isLoadingProject || isLoadingPool;

    const primary = buildPrimary({ pool, resolved, projectPrimarySource });

    const additional = buildAdditional({
      pool,
      resolved,
      projectPrimarySource,
      primaryId: primary?.id ?? null,
    });

    return { primary, additional, pool, isLoading, poolError };
  }, [
    pool,
    poolError,
    resolved,
    projectPrimarySource,
    isLoadingProject,
    isLoadingPool,
  ]);

  return result;
}

function determineProjectPrimarySource(
  settings: ProjectSettings,
  teamCount: number
): RepoSource | null {
  if (settings.repositoryOverrides) {
    return RepoSource.ProjectOverride;
  }
  if (teamCount === 1) {
    return RepoSource.TeamDefault;
  }
  return null;
}

type BuildPrimaryArgs = {
  pool: TeamRepoWithTeamId[];
  resolved: ReturnType<typeof resolveProjectRepoDefaults>;
  projectPrimarySource: RepoSource | null;
};

function buildPrimary({
  pool,
  resolved,
  projectPrimarySource,
}: BuildPrimaryArgs): ResolvedRepo | null {
  if (!resolved) {
    return null;
  }
  const fromPool = pool.find(
    (r) => r.installationRepositoryId === resolved.primaryRepoId
  );
  if (fromPool) {
    return {
      id: fromPool.installationRepositoryId,
      fullName: fromPool.repository.fullName,
      source: projectPrimarySource ?? RepoSource.ProjectOverride,
    };
  }
  return null;
}

type BuildAdditionalArgs = {
  pool: TeamRepoWithTeamId[];
  resolved: ReturnType<typeof resolveProjectRepoDefaults>;
  projectPrimarySource: RepoSource | null;
  primaryId: string | null;
};

function buildAdditional({
  pool,
  resolved,
  projectPrimarySource,
  primaryId,
}: BuildAdditionalArgs): ResolvedRepo[] {
  if (!resolved) {
    return [];
  }
  const additionalSource =
    projectPrimarySource === RepoSource.ProjectOverride ||
    projectPrimarySource === RepoSource.TeamDefault
      ? projectPrimarySource
      : RepoSource.TeamDefault;
  const out: ResolvedRepo[] = [];
  for (const id of resolved.selectedRepoIds) {
    if (id === primaryId) {
      continue;
    }
    const fromPool = pool.find((r) => r.installationRepositoryId === id);
    if (!fromPool) {
      continue;
    }
    out.push({
      id: fromPool.installationRepositoryId,
      fullName: fromPool.repository.fullName,
      source: additionalSource,
    });
  }
  return out;
}
