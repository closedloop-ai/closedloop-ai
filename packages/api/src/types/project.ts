import { z } from "zod";
import { ArtifactType } from "./artifact.ts";
import type { JsonObject, Priority } from "./common";
import type { CustomFieldValueDetail } from "./custom-field";
import type { TagSummary } from "./tag";
import type { ProjectTeamOption } from "./teams";
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
  /**
   * `null` is "no priority", the artifact priority contract (ISS-9833). Readers
   * tolerate it before the column can hold it: `apps/app` and `apps/api` deploy
   * independently, so no response may carry a value a deployed client cannot
   * render (ISS-9441).
   */
  priority: Priority | null;
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
   *
   * ISS-9922: `100` is RESERVED, not a rounding outcome. It is sent only when
   * every counted artifact is terminal; `0` is sent when none is. Everything in
   * between ROUNDS and is then capped at 99 (operator ruling 2026-09-18), so a
   * partial population can never reach `100` while the mid-range keeps the
   * value it has always sent — 2/3 is still `67`. The field's type and range are
   * unchanged, so a client on an older bundle reads it exactly as before; it now
   * receives `99` where 199 of 200 documents used to send `100`. Anything
   * downstream treating `=== 100` as "project complete" gets a truthful answer
   * rather than a promoted one.
   *
   * DEPLOY api-prod AHEAD OF app-prod for this change (davetho review). The
   * reserve is a PRODUCER guarantee and the field carries no marker saying it
   * was applied, so a new app talking to a not-yet-promoted API still receives
   * the legacy `100` for 199 of 200 and cannot tell it from a genuine one. That
   * window is the pre-ISS-9922 behaviour persisting, not a new defect, and it
   * closes the moment the API lands; a client-side refusal of every `100` from
   * an unknown producer would hide the check on genuinely complete projects
   * instead, which is a worse trade for a bounded window. An additive
   * producer-owned marker — the shape {@link completionPopulationEmpty} already
   * uses — is the fix if that window ever needs to be safe on its own.
   */
  completionPercentage: number;
  /**
   * `true` when the completion population is empty (no documents/issues to
   * complete), which is distinct from a real `0` (there are documents/issues
   * but none are complete). Additive and optional (ISS-4679): omitted when the
   * population is non-empty, so old clients that never read it degrade to the
   * legacy 0% behavior. ISS-4835: the empty case renders as a muted dash with
   * NO ring at all — not the dashed backlog-style track this docblock described
   * until #7530 — which is what `status-percentage-icon.tsx` and `name-cell.tsx`
   * both do.
   */
  completionPopulationEmpty?: boolean;
  teams: ProjectTeamOption[];
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
  /**
   * Required, and required to be non-empty at the API boundary
   * (`createProjectValidator`). A project with zero teams has no
   * `/teams/<teamId>/projects/<id>` URL, so it is invisible in the web UI while
   * still alive in the API — and `Artifact.project` is `onDelete: Cascade`, so
   * deleting one silently destroys its documents (ISS-6966).
   *
   * The required key is what stops a caller omitting it outright; non-emptiness
   * is the validator's job, since `string[]` still admits `[]`.
   */
  teamIds: string[];
};

export type UpdateProjectInput = {
  id: string;
  name?: string;
  description?: string;
  /**
   * ISS-11198: optimistic guards, each valid only beside its own field and
   * refused with `ProjectFieldMutationErrorCode`. An unset description is
   * expected as `""`, the value a client renders for it.
   */
  expectedName?: string;
  expectedDescription?: string;
  /** `null` clears it; omitted leaves it alone (ISS-9441). */
  priority?: Priority | null;
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

/**
 * Error codes the project routes emit as the `code` on a failure envelope.
 *
 * `ProjectTeamRequired` is the one a caller can act on without a human: its
 * `details.teams` (and, for MCP clients whose transport strips `details`, the
 * message itself) names the teams the caller may retry with. Gate it to denials
 * that team list can actually fix — never the over-cap denial, which more teams
 * cannot resolve.
 */
export const ProjectErrorCode = {
  ProjectTeamRequired: "project_team_required",
} as const;
export type ProjectErrorCode =
  (typeof ProjectErrorCode)[keyof typeof ProjectErrorCode];

/**
 * Upper bound on how many teams one project may be linked to.
 *
 * Enforced twice on purpose. The validators reject an over-cap array at the API
 * boundary, so a caller cannot make the route resolve an unbounded id list or
 * render one Zod issue per element; the service re-checks it because it is also
 * reachable from non-HTTP callers. Both read this constant so the two limits
 * cannot drift.
 */
export const MAX_PROJECT_TEAMS = 100;

/** The single wording for the over-cap denial, shared by both enforcement points. */
export const PROJECT_TEAM_CAP_MESSAGE = `A project can be linked to at most ${MAX_PROJECT_TEAMS} teams.`;
