import type { JsonObject } from "@repo/api/src/types/common";
import {
  getProjectSettings,
  type RepositoryOverrides,
  resolveProjectRepoDefaults,
} from "@repo/api/src/types/project";
import { teamsService } from "@/app/teams/service";

export type ResolvedProjectPrimaryRepo = {
  installationRepositoryId: string;
  fullName: string;
};

export type ResolvedProjectRepoDefaults = {
  override: RepositoryOverrides;
  primary: ResolvedProjectPrimaryRepo;
};

/**
 * Composes the pure resolver in `@repo/api/src/types/project` with the
 * per-project team-repository pool from `teamsService`. Returns:
 *   - `override`: ids the resolver decided on (post stale-id filtering)
 *   - `primary`: the primary repo's installation id + fullName. For
 *     pre-migration projects whose legacy `defaultRepository` references a
 *     repo not in the team pool, `primary` falls back to the legacy
 *     `repoFullName` cached on `settings`.
 *
 * Returns null when the user must pick at job launch (multi-team project
 * with no override and no usable legacy fallback).
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
    };
  }

  const legacy = settings.defaultRepository;
  if (legacy?.repoId === override.primaryRepoId) {
    return {
      override,
      primary: {
        installationRepositoryId: legacy.repoId,
        fullName: legacy.repoFullName,
      },
    };
  }

  // Unreachable: when `resolveProjectRepoDefaults` returns a non-null
  // override its `primaryRepoId` must come from either the team pool or the
  // legacy `defaultRepository`, both of which are checked above. Throwing
  // here surfaces an invariant break loudly instead of silently propagating
  // a null-primary state to callers.
  throw new Error(
    "Invariant: resolveProjectRepoDefaults returned an override whose primary is not in the team pool or legacy settings"
  );
}
