import type { JsonObject } from "@repo/api/src/types/common";
import {
  getProjectSettings,
  type RepositoryOverrides,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import type { TeamRepository } from "@repo/api/src/types/teams";
import { teamsService } from "@/app/teams/service";

export type ResolvedProjectPrimaryRepo = {
  installationRepositoryId: string;
  fullName: string;
};

export type ResolvedProjectRepoDefaults = {
  override: RepositoryOverrides;
  primary: ResolvedProjectPrimaryRepo;
  /**
   * The full team-repository pool fetched while resolving. Exposed so callers
   * that need to look up additional repos by id (e.g. `repository-snapshot-
   * helpers`) can reuse it instead of re-querying the same dataset.
   */
  teamRepos: TeamRepository[];
};

export type ResolvedProjectPrLinkRepo = ResolvedProjectPrimaryRepo & {
  role: "primary" | "additional";
};

/**
 * Composes the pure resolver in `@repo/api/src/types/project` with the
 * per-project team-repository pool from `teamsService`. Returns:
 *   - `override`: ids the resolver decided on (post stale-id filtering)
 *   - `primary`: the primary repo's installation id + fullName.
 *
 * Returns null when the user must pick at job launch (multi-team project
 * with no override).
 */
export async function loadProjectRepoDefaults(input: {
  projectId: string;
  organizationId: string;
  projectSettings: JsonObject;
}): Promise<ResolvedProjectRepoDefaults | null> {
  const { projectId, organizationId, projectSettings } = input;
  // teamCount must come from the project_teams table directly — counting
  // distinct team ids in `teamRepos` would miss teams that belong to the
  // project but have curated zero repositories, which would silently flip a
  // multi-team project into the single-team-inheritance path.
  const [teamRepos, teamCount] = await Promise.all([
    teamsService.getRepositoriesByProject(projectId, organizationId),
    teamsService.countTeamsForProject(projectId, organizationId),
  ]);
  const settings = getProjectSettings(projectSettings);

  const override = resolveProjectRepoDefaults({
    projectSettings: settings,
    teamRepos: teamRepos.map((r) => ({
      installationRepositoryId: r.installationRepositoryId,
      isDefaultSelected: r.isDefaultSelected,
      isPrimary: r.isPrimary,
    })),
    teamCount,
  });
  if (!override) {
    return null;
  }

  const primaryFromPool = teamRepos.find(
    (r) => r.installationRepositoryId === override.primaryRepoId
  );
  if (primaryFromPool) {
    return {
      override,
      primary: {
        installationRepositoryId: primaryFromPool.installationRepositoryId,
        fullName: primaryFromPool.repository.fullName,
      },
      teamRepos,
    };
  }

  // Unreachable: when `resolveProjectRepoDefaults` returns a non-null
  // override its `primaryRepoId` must come from the team pool — both the
  // override and single-team-inheritance branches resolve against it.
  // Throwing here surfaces an invariant break loudly instead of silently
  // propagating a null-primary state to callers.
  throw new Error(
    "Invariant: resolveProjectRepoDefaults returned an override whose primary is not in the team pool"
  );
}

/**
 * Resolve the repository allowlist for manually linking an existing PR. This
 * uses the same project repository defaults as job launch, but returns every
 * selected repository so additional repositories can be linked without making
 * the primary repo the only accepted target.
 */
export async function loadProjectPrLinkRepositories(input: {
  projectId: string;
  organizationId: string;
  projectSettings: JsonObject;
}): Promise<ResolvedProjectPrLinkRepo[]> {
  const { projectId, organizationId, projectSettings } = input;
  const [teamRepos, teamCount] = await Promise.all([
    teamsService.getRepositoriesByProject(projectId, organizationId),
    teamsService.countTeamsForProject(projectId, organizationId),
  ]);
  const settings = getProjectSettings(projectSettings);
  const override = resolveProjectRepoDefaults({
    projectSettings: settings,
    teamRepos: teamRepos.map((r) => ({
      installationRepositoryId: r.installationRepositoryId,
      isDefaultSelected: r.isDefaultSelected,
      isPrimary: r.isPrimary,
    })),
    teamCount,
  });
  if (!override) {
    return [];
  }

  const reposById = new Map(
    teamRepos.map((repo) => [
      repo.installationRepositoryId,
      {
        installationRepositoryId: repo.installationRepositoryId,
        fullName: repo.repository.fullName,
      },
    ])
  );
  const deduped: ResolvedProjectPrLinkRepo[] = [];
  const seen = new Set<string>();
  for (const repoId of override.selectedRepoIds) {
    if (seen.has(repoId)) {
      continue;
    }
    const repo = reposById.get(repoId);
    if (!repo) {
      continue;
    }
    seen.add(repoId);
    deduped.push({
      ...repo,
      role: repoId === override.primaryRepoId ? "primary" : "additional",
    });
  }
  return deduped;
}
