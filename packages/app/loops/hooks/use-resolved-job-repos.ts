"use client";

import { LoopCommand } from "@repo/api/src/types/loop";
import {
  getProjectSettings,
  type ProjectSettings,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { useInheritedAdditionalRepos } from "@repo/app/loops/hooks/use-loops";
import { useProject } from "@repo/app/projects/hooks/use-projects";
import {
  type TeamRepoWithTeamId,
  useTeamRepositoriesUnion,
} from "@repo/app/teams/hooks/use-team-repositories-union";
import { useMemo } from "react";

export const RepoSource = {
  PriorLoop: "prior-loop",
  ProjectOverride: "project-override",
  TeamDefault: "team-default",
  // Repo the user manually included in the picker; not seeded by the
  // resolver. Labeled separately so the row doesn't claim to come from team
  // defaults when it doesn't.
  UserAdded: "user-added",
} as const;
export type RepoSource = (typeof RepoSource)[keyof typeof RepoSource];

export type ResolvedRepo = {
  // Pool repos identify by `installationRepositoryId`. Prior-loop seeds not
  // found in the team pool carry their `fullName` here instead; in that case
  // `inPool` is false and the entry is informational only.
  id: string;
  fullName: string;
  source: RepoSource;
  inPool: boolean;
  // Pre-resolved branch — set for prior-loop peers (so the follow-up run keeps
  // the same branch the prior loop used). Unset for pool rows whose branch
  // should fall back to the GitHub default at submit time.
  branch?: string;
};

export type UseResolvedJobReposResult = {
  primary: ResolvedRepo | null;
  additional: ResolvedRepo[];
  pool: TeamRepoWithTeamId[];
  isLoading: boolean;
};

export type UseResolvedJobReposArgs = {
  projectId: string | null | undefined;
  // The artifact this job will run against. Used to look up the prior-loop
  // peer set; pass null for "no inheritance".
  artifactId?: string | null;
  // The command about to be launched. Drives prior-loop precedence on the
  // backend (e.g. PLAN inherits from GENERATE_PRD).
  command?: LoopCommand;
  // Optional carry-forward of the artifact's existing `targetRepo`. When the
  // resolver finds it inside the team pool it becomes the primary and is
  // labeled `prior-loop` if a prior loop exists, else falls through to the
  // project resolution chain's label.
  primaryFullNameSeed?: string | null;
  enabled?: boolean;
};

// Composes the resolution chain (prior loop > project override > single-team
// inheritance) plus per-repo source labels. The result is
// the seed state for `JobRepositoriesSection`; user edits inside the section
// override these values without writing them back to the project or team.
export function useResolvedJobRepos({
  projectId,
  artifactId,
  command,
  primaryFullNameSeed,
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
  const { repositories: pool, isLoading: isLoadingPool } =
    useTeamRepositoriesUnion({
      teamIds,
      enabled: enabled && teamIds.length > 0,
    });

  const inheritEnabled = enabled && Boolean(artifactId) && Boolean(command);
  const { data: inherited, isLoading: isLoadingInherited } =
    useInheritedAdditionalRepos(
      artifactId ?? null,
      // command is gated by inheritEnabled — when disabled the hook never
      // runs the queryFn so the fallback value is unused.
      command ?? LoopCommand.Plan,
      { enabled: inheritEnabled }
    );

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
    const isLoading =
      isLoadingProject ||
      isLoadingPool ||
      (inheritEnabled && isLoadingInherited);

    const hasPriorLoop = Boolean(inherited?.source);

    const primary = buildPrimary({
      pool,
      resolved,
      projectPrimarySource,
      primaryFullNameSeed: primaryFullNameSeed ?? null,
      hasPriorLoop,
    });

    const additional = buildAdditional({
      pool,
      resolved,
      projectPrimarySource,
      primaryId: primary?.id ?? null,
      priorPeers: inherited?.additionalRepos ?? [],
    });

    return { primary, additional, pool, isLoading };
  }, [
    pool,
    resolved,
    projectPrimarySource,
    primaryFullNameSeed,
    inherited,
    inheritEnabled,
    isLoadingProject,
    isLoadingPool,
    isLoadingInherited,
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
  primaryFullNameSeed: string | null;
  hasPriorLoop: boolean;
};

function buildPrimary({
  pool,
  resolved,
  projectPrimarySource,
  primaryFullNameSeed,
  hasPriorLoop,
}: BuildPrimaryArgs): ResolvedRepo | null {
  if (primaryFullNameSeed) {
    const fromPool = pool.find(
      (r) => r.repository.fullName === primaryFullNameSeed
    );
    if (fromPool) {
      return {
        id: fromPool.installationRepositoryId,
        fullName: fromPool.repository.fullName,
        source: hasPriorLoop
          ? RepoSource.PriorLoop
          : (projectPrimarySource ?? RepoSource.ProjectOverride),
        inPool: true,
      };
    }
    // Seed not in the team pool. Keep it only when a prior loop pinned it (so
    // the follow-up run targets the same repo); otherwise drop it and let the
    // project resolution chain below decide the primary.
    if (hasPriorLoop) {
      return {
        id: primaryFullNameSeed,
        fullName: primaryFullNameSeed,
        source: RepoSource.PriorLoop,
        inPool: false,
      };
    }
  }

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
      inPool: true,
    };
  }
  return null;
}

type BuildAdditionalArgs = {
  pool: TeamRepoWithTeamId[];
  resolved: ReturnType<typeof resolveProjectRepoDefaults>;
  projectPrimarySource: RepoSource | null;
  primaryId: string | null;
  priorPeers: Array<{ fullName: string; branch: string }>;
};

function buildAdditional({
  pool,
  resolved,
  projectPrimarySource,
  primaryId,
  priorPeers,
}: BuildAdditionalArgs): ResolvedRepo[] {
  if (priorPeers.length > 0) {
    const out: ResolvedRepo[] = [];
    for (const peer of priorPeers) {
      const fromPool = pool.find(
        (r) => r.repository.fullName === peer.fullName
      );
      if (fromPool) {
        out.push({
          id: fromPool.installationRepositoryId,
          fullName: fromPool.repository.fullName,
          source: RepoSource.PriorLoop,
          inPool: true,
          branch: peer.branch,
        });
        continue;
      }
      out.push({
        id: peer.fullName,
        fullName: peer.fullName,
        source: RepoSource.PriorLoop,
        inPool: false,
        branch: peer.branch,
      });
    }
    return out;
  }

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
      inPool: true,
    });
  }
  return out;
}
