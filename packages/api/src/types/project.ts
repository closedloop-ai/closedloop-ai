import { z } from "zod";
import type { JsonObject, Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { BasicUser } from "./user";

export const ProjectStatus = {
  NotStarted: "NOT_STARTED",
  InProgress: "IN_PROGRESS",
  Completed: "COMPLETED",
  Archived: "ARCHIVED",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export type Project = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  priority: Priority;
  status: ProjectStatus;
  assigneeId: string | null;
  createdById: string;
  slug: string | null;
  targetDate: Date | null;
  codebaseSummary: string | null;
  lastIndexedAt: Date | null;
  settings: JsonObject;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectWithOrganization = Project & {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

export type ProjectWithDetails = Project & {
  assignee?: BasicUser;
  completionPercentage: number; // 0-100 percentage from calculateStatus()
  teams: Array<{ id: string; name: string }>;
  /** Custom field values attached to this project. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  priority?: Priority;
  status?: ProjectStatus;
  assigneeId?: string | null;
  slug?: string | null;
  targetDate?: Date | null;
  teamIds?: string[];
};

export type UpdateProjectInput = {
  id: string;
  name?: string;
  description?: string;
  priority?: Priority;
  status?: ProjectStatus;
  assigneeId?: string | null;
  targetDate?: Date | null;
  teamIds?: string[];
  settings?: JsonObject;
  codebaseSummary?: string | null;
  lastIndexedAt?: Date | null;
};

export type FavoriteResponse = {
  favorited: boolean;
};

// Repository types
export type Repository = {
  id: string;
  projectId: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateRepositoryInput = {
  projectId: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  isPrimary?: boolean;
};

// =============================================================================
// Project Settings (stored in the `settings` JSON column)
// =============================================================================

/**
 * Legacy single-default-repo shape. Superseded by `repositoryOverrides`.
 * Kept on the type so that pre-migration data continues to round-trip and so
 * the legacy fallback in `resolveProjectRepoDefaults()` has a stable input
 * shape. New writes should populate `repositoryOverrides`.
 */
export type DefaultRepository = {
  repoId: string;
  repoFullName: string;
  branch: string;
};

/**
 * Project-level override of which team repositories are pre-selected for new
 * jobs and which one is the primary. IDs reference
 * `GitHubInstallationRepository.id` (the same id space used by the team
 * repository pool). Branches are intentionally not stored — the GitHub default
 * branch of each repo is used at job-launch time (Q-002 of PLN-237).
 */
export type RepositoryOverrides = {
  selectedRepoIds: string[];
  primaryRepoId: string;
};

export type ProjectSettings = {
  defaultRepository?: DefaultRepository;
  repositoryOverrides?: RepositoryOverrides;
};

const defaultRepositoryValidator = z.object({
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  branch: z.string().min(1),
});

export const repositoryOverridesValidator = z
  .object({
    selectedRepoIds: z.array(z.string().min(1)),
    primaryRepoId: z.string().min(1),
  })
  .refine((value) => value.selectedRepoIds.includes(value.primaryRepoId), {
    message: "primaryRepoId must be one of selectedRepoIds",
    path: ["primaryRepoId"],
  });

export function getProjectSettings(settings: JsonObject): ProjectSettings {
  const result: ProjectSettings = {};
  // Each known field is parsed independently so a malformed value for one key
  // does not void an unrelated valid value on the same settings object.
  const legacy = defaultRepositoryValidator.safeParse(
    settings.defaultRepository
  );
  if (legacy.success) {
    result.defaultRepository = legacy.data;
  }
  const override = repositoryOverridesValidator.safeParse(
    settings.repositoryOverrides
  );
  if (override.success) {
    result.repositoryOverrides = override.data;
  }
  return result;
}

// =============================================================================
// Repository Default Resolution
// =============================================================================

/**
 * Minimal team-repository row shape required by the resolver. Callers map
 * their own row type onto this.
 */
export type ResolverTeamRepo = {
  installationRepositoryId: string;
  isDefaultSelected: boolean;
  isPrimary: boolean;
};

export type ResolveProjectRepoDefaultsInput = {
  projectSettings: ProjectSettings;
  teamRepos: ResolverTeamRepo[];
  /** Number of distinct teams the project belongs to. */
  teamCount: number;
};

/**
 * Resolution chain for a project's repository defaults:
 *
 *  1. Project override (`settings.repositoryOverrides`) — stale ids that no
 *     longer exist in the team pool are filtered out; the override is dropped
 *     entirely if filtering removes the primary or empties the selected list.
 *  2. Single-team inheritance — when the project belongs to exactly one team
 *     and has no override, the team's default-selected repos are inherited
 *     and the team's primary becomes the project primary.
 *  3. Legacy `defaultRepository` fallback — pre-migration projects whose
 *     legacy `repoId` still exists in the team pool resolve to that single
 *     repo as both selection and primary.
 *  4. Otherwise null — the user must pick repos at job launch (multi-team
 *     project with no override and no legacy fallback).
 */
export function resolveProjectRepoDefaults(
  input: ResolveProjectRepoDefaultsInput
): RepositoryOverrides | null {
  const { projectSettings, teamRepos, teamCount } = input;
  const poolIds = new Set(teamRepos.map((r) => r.installationRepositoryId));

  const override = projectSettings.repositoryOverrides;
  if (override) {
    const filteredSelected = override.selectedRepoIds.filter((id) =>
      poolIds.has(id)
    );
    // `filteredSelected` is by construction a subset of `poolIds`, so
    // `includes(primaryRepoId)` already implies the primary is in the pool
    // and that the list is non-empty.
    if (filteredSelected.includes(override.primaryRepoId)) {
      return {
        selectedRepoIds: filteredSelected,
        primaryRepoId: override.primaryRepoId,
      };
    }
  }

  if (teamCount === 1) {
    const inherited = inheritFromSingleTeam(teamRepos);
    if (inherited) {
      return inherited;
    }
  }

  const legacy = projectSettings.defaultRepository;
  if (legacy && (poolIds.size === 0 || poolIds.has(legacy.repoId))) {
    return {
      selectedRepoIds: [legacy.repoId],
      primaryRepoId: legacy.repoId,
    };
  }

  return null;
}

function inheritFromSingleTeam(
  teamRepos: ResolverTeamRepo[]
): RepositoryOverrides | null {
  const primary = teamRepos.find((r) => r.isPrimary);
  if (!primary) {
    return null;
  }
  const defaults = teamRepos.filter(
    (r) =>
      r.isDefaultSelected ||
      r.installationRepositoryId === primary.installationRepositoryId
  );
  return {
    selectedRepoIds: defaults.map((r) => r.installationRepositoryId),
    primaryRepoId: primary.installationRepositoryId,
  };
}
