import { z } from "zod";
import { ArtifactType } from "./artifact.ts";
import type { JsonObject, Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { TagSummary } from "./tag";
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

export type ProjectWithDetails = Project & {
  assignee?: BasicUser;
  /**
   * 0-100 percentage from `calculateStatus()`, over the artifact population
   * named by {@link PROJECT_COMPLETION_ARTIFACT_TYPE} — documents only, not
   * every artifact of the project (ISS-4636).
   *
   * Always a number so the wire contract stays version-skew safe: already
   * installed Desktop builds and external API clients that validate or do
   * arithmetic against this field keep working (AGENTS.md cross-repo rule). An
   * empty population serializes `0` here, and the empty case is signalled
   * additively by {@link completionPopulationEmpty} — old clients that ignore
   * that flag simply see a 0% project, the pre-ISS-4679 behavior.
   */
  completionPercentage: number;
  /**
   * `true` when the completion population is empty (no documents/issues to
   * complete), which is distinct from a real `0` (there are documents/issues
   * but none are complete). Additive and optional (ISS-4679): omitted when the
   * population is non-empty, so old clients that never read it degrade to the
   * legacy 0% behavior. The ring renders the empty case as a dashed
   * backlog-style track rather than a solid 0%.
   */
  completionPopulationEmpty?: boolean;
  teams: Array<{ id: string; name: string }>;
  /** Custom field values attached to this project. Omitted when not requested. */
  customFields?: CustomFieldValueDetail[];
  tags?: TagSummary[];
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

// =============================================================================
// Project Settings (stored in the `settings` JSON column)
// =============================================================================

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
  repositoryOverrides?: RepositoryOverrides;
};

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
 *  3. Otherwise null — the user must pick repos at job launch (multi-team
 *     project with no override).
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

/**
 * The artifact population that {@link ProjectWithDetails.completionPercentage}
 * summarizes: DOCUMENT-typed artifacts only. A project's BRANCH, SESSION, and
 * DEPLOYMENT artifacts are in neither the numerator nor the denominator
 * (ISS-4636).
 *
 * That exclusion is a scope decision, not a claim that those types are
 * statusless. A branch does carry a status vocabulary — `PullRequestDetail`
 * has `prState` (OPEN/MERGED/CLOSED), the dashboard already treats MERGED as
 * terminal, and `BRANCH_STATUS_TO_ICON` renders Merged as "complete". What is
 * undecided is the *product* question: whether merging a PR should move a
 * project's completion number, whether an abandoned (CLOSED, unmerged) branch
 * counts as complete or merely finished, and whether SESSION and DEPLOYMENT
 * artifacts join the population too. `calculateStatus`'s terminal predicate is
 * subtype-scoped to the Document and Issue vocabularies and has no answer for
 * any of that, so the population stays as-counted and the label was corrected
 * to match it. Widening this is an open product question — see ISS-4636.
 *
 * `apps/api`'s project query filters its `artifacts` include by this value, and
 * the completion-ring copy names this same population
 * (`PROJECT_COMPLETION_POPULATION_NOUN` in
 * `@repo/app/projects/lib/project-constants`, which pins itself to this
 * constant). The two MUST change together — widening the population without
 * renaming the label, or the reverse, is exactly the drift ISS-4636 reported.
 */
export const PROJECT_COMPLETION_ARTIFACT_TYPE = ArtifactType.Document;
