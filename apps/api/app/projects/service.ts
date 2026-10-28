import type { JsonObject, Priority } from "@repo/api/src/types/common";
import { isTerminalStatusForSubtype } from "@repo/api/src/types/document";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import {
  type CreateProjectInput,
  MAX_PROJECT_TEAMS,
  PROJECT_COMPLETION_ARTIFACT_TYPE,
  PROJECT_TEAM_CAP_MESSAGE,
  ProjectStatus,
  type ProjectWithDetails,
  type UpdateProjectInput,
} from "@repo/api/src/types/project";
import {
  type ProjectFieldMutationError,
  staleProjectDescriptionConflict,
  staleProjectNameConflict,
} from "@repo/api/src/types/project-field-mutation";
import { Result, Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma, type Project as PrismaProject, withDb } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import type { FavoriteWrite } from "@/app/artifacts/favorites-service";
import {
  projectProjection,
  searchIndexService,
} from "@/app/search/search-index-service";
import {
  mapTagRelations,
  TAG_RELATION_INCLUDE,
} from "@/app/tags/tag-projection-select";
import { fieldsThatMoved } from "@/lib/operation-receipts/changed-fields";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import { generateSlug } from "@/lib/slug-generator";
import {
  isUserInOrganization,
  orgCheckedUserSelect,
  projectAssigneeInOrganization,
  USER_NOT_IN_ORGANIZATION_MESSAGE,
} from "@/lib/user-org-membership";
import {
  PROJECT_TEAMS_CHANGED_FIELD,
  PROJECT_UPDATE_FIELDS,
  PROJECT_UPDATE_SELECT,
} from "./project-update-receipt";

/**
 * Projects service - handles database operations for project management
 */
export const projectsService = {
  /**
   * Find all projects for an organization
   */
  async findByOrganization(
    organizationId: string,
    options?: ProjectListOptions
  ): Promise<ProjectWithDetails[]> {
    const statusFilter = buildProjectStatusFilter(options);
    const projects = await withDb((db) =>
      db.project.findMany({
        where: {
          organizationId,
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
        ...(options?.limit && { take: options.limit }),
      })
    );
    return projects.map((p) => toProjectWithDetails(p));
  },

  /**
   * Find projects by team ID
   */
  async findByTeam(
    teamId: string,
    organizationId: string,
    options?: ProjectListOptions
  ): Promise<ProjectWithDetails[]> {
    const statusFilter = buildProjectStatusFilter(options);
    const projects = await withDb((db) =>
      db.project.findMany({
        where: {
          organizationId,
          teams: {
            some: { teamId },
          },
          ...(statusFilter ? { status: statusFilter } : {}),
        },
        include: PROJECT_DETAIL_INCLUDE,
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
        ...(options?.limit && { take: options.limit }),
      })
    );
    return projects.map((p) => toProjectWithDetails(p));
  },

  /**
   * Find a project by ID with all details
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<ProjectWithDetails | null> {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { id, organizationId },
        include: PROJECT_DETAIL_INCLUDE,
      })
    );
    return project ? toProjectWithDetails(project) : null;
  },

  /**
   * Find a project by slug with all details
   */
  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<ProjectWithDetails | null> {
    const project = await withDb((db) =>
      db.project.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: PROJECT_DETAIL_INCLUDE,
      })
    );
    return project ? toProjectWithDetails(project) : null;
  },

  /**
   * Create a new project
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateProjectInput,
    recordCreated?: RecordWriteInTransaction<PrismaProject>
  ): Promise<Result<PrismaProject, ProjectWriteError>> {
    const { teamIds, ...projectData } = input;
    if (!(await isAssignableInOrg(projectData.assigneeId, organizationId))) {
      return Result.err(ASSIGNEE_NOT_IN_ORGANIZATION);
    }

    const slug = await generateSlug(organizationId, SlugPrefix.Project);

    const created = await withDb
      .tx(async (tx) => {
        const project = await tx.project.create({
          data: {
            ...projectData,
            organizationId,
            slug,
            createdById: userId,
          },
        });

        // `teamIds` is required and validated non-empty at the API boundary
        // (ISS-6966), so there is no teamless create left to guard against.
        const resolvedTeamIds = await resolveOrgTeamIds(
          tx,
          teamIds,
          organizationId
        );

        await tx.projectTeam.createMany({
          data: resolvedTeamIds.map((teamId) => ({
            projectId: project.id,
            teamId,
          })),
          skipDuplicates: true,
        });

        await recordCreated?.(tx, project);
        return project;
      })
      .then((project) => {
        // FEA-3863 / Phase-2: best-effort, post-commit, fail-open projection
        // upsert. The owning team (for the team-scoped project route) is the
        // first team the project was just added to, if any.
        indexProjectProjection(project, teamIds[0]);
        return project;
      });
    return Result.ok(created);
  },

  /**
   * Update a project
   */
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateProjectInput, "id">,
    recordUpdated?: RecordWriteInTransaction<UpdatedProjectWrite>
  ): Promise<
    Result<UpdatedProject, ProjectWriteError | ProjectFieldMutationError>
  > {
    // `teamIds` is the ProjectTeam relation and the `expected*` keys are guards,
    // not Project columns: leaving any in `data` makes Prisma reject the whole
    // update (ISS-6561).
    const {
      teamIds,
      expectedName: _expectedName,
      expectedDescription: _expectedDescription,
      ...projectData
    } = input;
    if (!(await isAssignableInOrg(projectData.assigneeId, organizationId))) {
      return Result.err(ASSIGNEE_NOT_IN_ORGANIZATION);
    }

    const written = await withDb.tx(
      async (
        tx
      ): Promise<Result<UpdatedProject, ProjectFieldMutationError>> => {
        // ISS-9688 (#7225 review, whitlockk and codex): the audit receipt's
        // before-image is read HERE, under the row lock this update will take
        // anyway, and returned alongside the written row.
        //
        // The route used to diff a pre-update `findById` against a post-update
        // `findById` — three separate statements on three connections with the
        // whole update and the custom-field work in between. A second PUT
        // landing in either gap put ITS transition on the append-only ledger
        // under THIS request's actor, or recorded a `from` that was never this
        // writer's. The ledger is hashed and cannot be corrected afterwards, so
        // a wrong row there is permanent.
        //
        // `FOR UPDATE` rather than a bare read because the transaction runs at
        // READ COMMITTED: an unlocked `findUnique` here would still let a
        // concurrent writer commit between the read and the update, which is
        // the same lost-update the lock exists to serialize (same shape as
        // `apps/api/app/comments/service.ts`). A concurrent PUT now blocks
        // until this one commits and reads this row as ITS before-image.
        const locked = await tx.$queryRaw<ProjectBeforeImage[]>`
          SELECT "status", "priority", "name", "description"
            FROM "projects"
           WHERE "id" = ${id}::uuid
             AND "organization_id" = ${organizationId}::uuid
           FOR UPDATE`;
        const previous = locked[0] ?? null;
        // ISS-11198: compared on the locked before-image, so no writer can land
        // between this check and the update below.
        const stale = previous && staleProjectField(id, previous, input);
        if (stale) {
          return Result.err(stale);
        }
        // ISS-12552 flag-off parity: unrecorded, main's update and team
        // replace; recorded, the same writes plus the reads its receipt's
        // diff needs, under the lock above.
        return writeInShape(recordUpdated, {
          unrecorded: async () => {
            const project = await tx.project.update({
              where: { id, organizationId },
              data: projectData,
            });

            // Update team associations if specified
            if (project && teamIds !== undefined) {
              const resolvedTeamIds = await resolveOrgTeamIds(
                tx,
                teamIds,
                organizationId
              );

              await tx.projectTeam.deleteMany({ where: { projectId: id } });

              if (resolvedTeamIds.length > 0) {
                await tx.projectTeam.createMany({
                  data: resolvedTeamIds.map((teamId) => ({
                    projectId: id,
                    teamId,
                  })),
                  skipDuplicates: true,
                });
              }
            }

            return Result.ok({ project, previous });
          },
          recorded: async (record) => {
            const before = await tx.project.findFirst({
              where: { id, organizationId },
              select: PROJECT_UPDATE_SELECT,
            });
            const project = await tx.project.update({
              where: { id, organizationId },
              data: projectData,
            });
            const teamsChanged =
              teamIds !== undefined &&
              (await replaceProjectTeams(tx, id, teamIds, organizationId));
            const changedFields = [
              ...(before
                ? fieldsThatMoved(
                    PROJECT_UPDATE_FIELDS,
                    projectData,
                    before,
                    project
                  )
                : []),
              ...(teamsChanged ? [PROJECT_TEAMS_CHANGED_FIELD] : []),
            ];
            await record(tx, { project, previous, changedFields });
            return Result.ok({ project, previous });
          },
        });
      }
    );
    if (written.ok) {
      // FEA-3863 / Phase-2: best-effort, post-commit, fail-open projection
      // upsert. When this update set the teams, the owning team is the first
      // of them; otherwise it is left unresolved (undefined) so the indexer
      // reads the current owning team instead of clobbering it.
      const teamId = teamIds === undefined ? undefined : (teamIds[0] ?? null);
      indexProjectProjection(written.value.project, teamId);
    }
    return written;
  },

  /**
   * Delete a project. `recordDeleted` runs on the delete's transaction, so a
   * receipt that cannot be stored keeps the project (ISS-12552).
   */
  delete(
    id: string,
    organizationId: string,
    recordDeleted?: RecordWriteInTransaction<{ projectId: string }>
  ) {
    return withDb
      .tx(async (tx) => {
        // Remove team associations first
        await tx.projectTeam.deleteMany({ where: { projectId: id } });
        const project = await tx.project.delete({
          where: { id, organizationId },
        });
        await recordDeleted?.(tx, { projectId: id });
        return project;
      })
      .then((project) => {
        // FEA-3863: best-effort, post-commit, fail-open search projection removal.
        searchIndexService.removeAfterCommit({
          organizationId,
          entityType: SearchEntityType.Project,
          entityId: id,
        });
        return project;
      });
  },

  /**
   * Reorder projects by setting sortOrder values.
   * Accepts an array of project IDs in the desired order.
   */
  reorder(projectIds: string[], organizationId: string): Promise<string[]> {
    if (projectIds.length === 0) {
      return Promise.resolve([]);
    }

    const uniqueIds = [...new Set(projectIds)];

    return withDb.tx(async (tx) => {
      const projects = await tx.project.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      });

      if (projects.length !== uniqueIds.length) {
        const foundIds = new Set(projects.map((p) => p.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid project IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      const valueRows = uniqueIds.map(
        (id, index) => Prisma.sql`(${id}::uuid, ${index}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "projects"
        SET "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "projects"."id" = data.id
          AND "projects"."organization_id" = ${organizationId}::uuid
      `);

      return uniqueIds;
    });
  },

  /**
   * Add a project to the user's favorites (idempotent). Recorded, the favorite
   * and `recordWrite` share one transaction and the record learns whether a
   * row was inserted, so a receipt that cannot be stored rolls the favorite
   * back (ISS-12552); unrecorded, it is main's autocommit upsert.
   */
  addFavorite(
    projectId: string,
    userId: string,
    organizationId: string,
    recordWrite?: RecordWriteInTransaction<FavoriteWrite>
  ) {
    return writeInShape(recordWrite, {
      unrecorded: () =>
        withDb(async (db) => {
          // Verify project belongs to this org
          const project = await db.project.findUnique({
            where: { id: projectId, organizationId },
            select: { id: true },
          });
          if (!project) {
            return null;
          }
          await db.favoriteProject.upsert({
            where: { userId_projectId: { userId, projectId } },
            create: { userId, projectId },
            update: {},
            select: { id: true },
          });
          return { favorited: true };
        }),
      recorded: (record) =>
        withDb.tx(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: projectId, organizationId },
            select: { id: true },
          });
          if (!project) {
            return null;
          }
          const { count } = await tx.favoriteProject.createMany({
            data: [{ userId, projectId }],
            skipDuplicates: true,
          });
          await record(tx, { favorited: true, changed: count > 0 });
          return { favorited: true };
        }),
    });
  },

  /**
   * Remove a project from the user's favorites. Recorded, `recordWrite` runs
   * on the delete's transaction (ISS-12552); unrecorded, it is main's
   * autocommit delete.
   */
  removeFavorite(
    projectId: string,
    userId: string,
    organizationId: string,
    recordWrite?: RecordWriteInTransaction<FavoriteWrite>
  ) {
    return writeInShape(recordWrite, {
      unrecorded: () =>
        withDb(async (db) => {
          // Verify project belongs to this org
          const project = await db.project.findUnique({
            where: { id: projectId, organizationId },
            select: { id: true },
          });
          if (!project) {
            return null;
          }
          await db.favoriteProject.deleteMany({
            where: { userId, projectId },
          });
          return { favorited: false };
        }),
      recorded: (record) =>
        withDb.tx(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: projectId, organizationId },
            select: { id: true },
          });
          if (!project) {
            return null;
          }
          const { count } = await tx.favoriteProject.deleteMany({
            where: { userId, projectId },
          });
          await record(tx, { favorited: false, changed: count > 0 });
          return { favorited: false };
        }),
    });
  },

  /**
   * Find all favorite projects for a user within an organization.
   * Returns projects mapped to API format, ordered by when they were favorited.
   */
  async findFavoritesByUser(
    userId: string,
    organizationId: string
  ): Promise<ProjectWithDetails[]> {
    const favorites = await withDb((db) =>
      db.favoriteProject.findMany({
        where: {
          userId,
          project: {
            organizationId,
            status: { not: ProjectStatus.Archived },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        include: {
          project: {
            include: PROJECT_DETAIL_INCLUDE,
          },
        },
      })
    );
    return favorites.map((f) => toProjectWithDetails(f.project));
  },

  /**
   * Calculate project completion over the DOCUMENT artifacts the caller passes
   * in — the population defined by `PROJECT_COMPLETION_ARTIFACT_TYPE`, which is
   * what `PROJECT_DETAIL_INCLUDE` selects. Branch, session, and deployment
   * artifacts of the project are deliberately outside both the numerator and
   * the denominator (ISS-4636), so the UI copy names documents, not artifacts.
   */
  calculateStatus(
    artifacts: Array<{ status: string; subtype: string | null }>
  ): number | null {
    // An empty population has no percentage to report. `null` distinguishes
    // "there are no documents or issues to complete" from a real 0-of-N, which
    // the ring renders differently (a dashed empty-state track vs a solid 0%).
    if (artifacts.length === 0) {
      return null;
    }

    // Documents and Features have distinct terminal vocabularies (PRD-495);
    // an artifact counts as complete when it has reached a terminal status for
    // its own subtype.
    const completedCount = artifacts.filter((a) =>
      isTerminalStatusForSubtype(a.subtype, a.status)
    ).length;

    // 100 and 0 are terminal claims about the population, and they are made
    // FROM THE COUNTS rather than from arithmetic on a ratio: this function
    // owns the numerator and denominator, so it can say "every one" and "none"
    // exactly. 199 of 200 documents is 99.5%, which `Math.round` promoted to a
    // filled complete check with nothing left on the row to contradict it
    // (ISS-9922).
    if (completedCount === artifacts.length) {
      return 100;
    }
    if (completedCount === 0) {
      return 0;
    }
    // Multiply before dividing: `(completedCount / n) * 100` can land a hair
    // under an exact integer in binary floating point, which rounding then
    // carries into the sent value.
    //
    // ROUND, THEN CAP AT 99 (operator ruling 2026-09-18). The guards above have
    // already made both terminal claims, so everything reaching here is a
    // genuine partial and the only job left is to stop it rounding INTO 100.
    // Flooring the mid-range instead would have moved the number on roughly
    // half of all partial projects — 2/3 from 67 to 66 — which the ticket did
    // not ask for and no human ruled on; rounding is what shipped and what
    // stays. The same rule is applied to a bare percentage by
    // `packages/design-system/lib/completion-percentage.ts`; this one owns the
    // counts, which that one never sees, so the two cannot be one function.
    return Math.min(99, Math.round((completedCount * 100) / artifacts.length));
  },

  /**
   * Strip the GitHub-installation-bound fields out of every project's
   * `settings` JSON for an organization. Used by the PLN-634
   * different-account reconnect cleanup: the prior installation's repo
   * UUIDs are no longer valid references, so the resolver would fall
   * through to "pick at job launch" regardless, but explicitly clearing
   * keeps the settings JSON honest and avoids stale fullNames after a
   * reset.
   *
   * Returns the number of projects whose settings were rewritten. Safe to
   * call from inside an outer `withDb.tx` — joins the active transaction
   * via AsyncLocalStorage.
   */
  clearRepositorySettingsForOrganization(
    organizationId: string
  ): Promise<number> {
    return withDb.tx(async (tx) => {
      const projects = await tx.project.findMany({
        where: { organizationId },
        select: { id: true, settings: true },
      });
      let cleared = 0;
      for (const project of projects) {
        const current = (project.settings ?? {}) as Record<string, unknown>;
        if (!("repositoryOverrides" in current)) {
          continue;
        }
        const { repositoryOverrides, ...rest } = current;
        await tx.project.update({
          where: { id: project.id },
          data: { settings: rest as Prisma.InputJsonValue },
          select: { id: true },
        });
        cleared++;
      }
      return cleared;
    });
  },
};

type ProjectListOptions = {
  limit?: number;
  status?: ProjectStatus[];
  excludeStatus?: ProjectStatus[];
};

/**
 * Standard include pattern for project queries with assignee, teams, and artifacts
 */
const PROJECT_DETAIL_INCLUDE = {
  assignee: orgCheckedUserSelect,
  teams: {
    include: {
      team: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  // The completion population (ISS-4636): documents only. Widening this filter
  // also widens what `completionPercentage` means, so the shared constant — and
  // the noun the UI renders next to it — must move with it.
  artifacts: {
    where: { type: PROJECT_COMPLETION_ARTIFACT_TYPE },
    select: { status: true, subtype: true },
  },
  tagProjects: {
    include: TAG_RELATION_INCLUDE,
  },
} as const;

/** Type for project returned from database with includes */
type ProjectFromDb = Prisma.ProjectGetPayload<{
  include: typeof PROJECT_DETAIL_INCLUDE;
}>;

function toProjectWithDetails(project: ProjectFromDb): ProjectWithDetails {
  const assignee = projectAssigneeInOrganization(project, project.assignee);
  return {
    ...project,
    settings: project.settings as JsonObject,
    // A foreign assignee's id is dropped with the user: the id alone still
    // names a user in another organization (ISS-10989).
    assigneeId: assignee?.id ?? null,
    assignee: assignee ?? undefined,
    ...toCompletionFields(projectsService.calculateStatus(project.artifacts)),
    teams: project.teams.map((pt) => ({
      id: pt.team.id,
      name: pt.team.name,
    })),
    tags: mapTagRelations(project.tagProjects ?? []),
  };
}

/**
 * Map the internal completion signal (`calculateStatus`'s `number | null`, where
 * `null` = empty population) onto the version-skew-safe wire shape: a numeric
 * `completionPercentage` (0 for empty, so old clients keep a valid number) plus
 * the additive optional `completionPopulationEmpty` flag, which is *omitted*
 * (never serialized `false`/`null`) when the population is non-empty so absent
 * degrades to the legacy 0% behavior (ISS-4679, AGENTS.md cross-repo rule).
 */
function toCompletionFields(
  status: number | null
): Pick<
  ProjectWithDetails,
  "completionPercentage" | "completionPopulationEmpty"
> {
  if (status === null) {
    return { completionPercentage: 0, completionPopulationEmpty: true };
  }
  return { completionPercentage: status };
}

function buildProjectStatusFilter(
  options?: ProjectListOptions
): Prisma.EnumProjectStatusFilter | undefined {
  const hasStatus = (options?.status?.length ?? 0) > 0;
  const hasExcludeStatus = (options?.excludeStatus?.length ?? 0) > 0;
  if (!(hasStatus || hasExcludeStatus)) {
    return undefined;
  }

  return {
    ...(hasStatus
      ? {
          in: options?.status,
        }
      : {}),
    ...(hasExcludeStatus
      ? {
          notIn: options?.excludeStatus,
        }
      : {}),
  };
}

/**
 * FEA-3863 / Phase-2: index a project into the search projection with its
 * routing metadata. `teamId` is the owning team for the team-scoped project
 * route: the caller passes the just-set team (or `null` for none) when it knows
 * it, or `undefined` when a metadata-only update left the teams untouched — in
 * which case the current first team is read from the source of truth so a
 * non-team update does not clobber the projected team. Best-effort throughout:
 * the upsert already runs post-commit via `waitUntil` and swallows errors, and
 * the team read is scheduled the same way so a failed read never affects the
 * user's write.
 */
function indexProjectProjection(
  project: PrismaProject,
  teamId: string | null | undefined
): void {
  const index = (resolvedTeamId: string | null) =>
    searchIndexService.indexAfterCommit(
      projectProjection({
        id: project.id,
        organizationId: project.organizationId,
        name: project.name,
        slug: project.slug,
        teamId: resolvedTeamId,
        description: project.description,
        assigneeId: project.assigneeId,
        status: project.status,
        priority: project.priority,
        updatedAt: project.updatedAt,
      })
    );

  if (teamId !== undefined) {
    index(teamId);
    return;
  }

  waitUntil(
    firstProjectTeamId(project.id)
      .catch(() => null)
      .then((resolvedTeamId) => index(resolvedTeamId))
  );
}

/**
 * The id of the first team a project belongs to, or null when it has none.
 * Read only by the best-effort search indexer, so a null (no team) is a safe
 * fallback rather than an error.
 */
function firstProjectTeamId(projectId: string): Promise<string | null> {
  return withDb(async (db) => {
    const membership = await db.projectTeam.findFirst({
      where: { projectId },
      select: { teamId: true },
    });
    return membership?.teamId ?? null;
  });
}

/**
 * Why a requested `teamIds` set was refused. The two reasons need different
 * responses: `Unresolved` is fixable by naming a real team, so the route offers
 * the caller its org's teams; `OverCap` is not, and attaching a team roster to
 * it would be remediation the caller cannot act on.
 */
export const InvalidProjectTeamsReason = {
  OverCap: "over_cap",
  Unresolved: "unresolved",
} as const;
export type InvalidProjectTeamsReason =
  (typeof InvalidProjectTeamsReason)[keyof typeof InvalidProjectTeamsReason];

export class InvalidProjectTeamsError extends Error {
  readonly reason: InvalidProjectTeamsReason;

  constructor(message: string, reason: InvalidProjectTeamsReason) {
    super(message);
    this.name = "InvalidProjectTeamsError";
    this.reason = reason;
  }
}

/**
 * Resolve the requested team IDs against the caller's own organization, inside
 * the caller's transaction, so a project can only ever be linked to teams the
 * caller can already see.
 *
 * Rejecting the whole write — rather than dropping the teams that did not
 * resolve — is deliberate: a partial apply would return a project whose `teams`
 * silently disagree with what the caller asked for. The message deliberately
 * does not distinguish "no such team" from "team in another organization", so a
 * caller cannot probe for foreign team IDs.
 */
async function resolveOrgTeamIds(
  tx: Prisma.TransactionClient,
  teamIds: string[],
  organizationId: string
): Promise<string[]> {
  // Bound the caller's input before doing any work with it; the unique
  // (projectId, teamId) constraint makes duplicates a write error otherwise.
  if (teamIds.length > MAX_PROJECT_TEAMS) {
    throw new InvalidProjectTeamsError(
      PROJECT_TEAM_CAP_MESSAGE,
      InvalidProjectTeamsReason.OverCap
    );
  }

  const uniqueTeamIds = [...new Set(teamIds)];
  if (uniqueTeamIds.length === 0) {
    return uniqueTeamIds;
  }

  const teams = await tx.team.findMany({
    where: { id: { in: uniqueTeamIds }, organizationId },
    select: { id: true },
  });

  if (teams.length !== uniqueTeamIds.length) {
    throw new InvalidProjectTeamsError(
      "One or more teams were not found in this organization.",
      InvalidProjectTeamsReason.Unresolved
    );
  }

  return uniqueTeamIds;
}

type ProjectBeforeImage = {
  status: ProjectStatus;
  priority: Priority | null;
  name: string;
  description: string | null;
};

/**
 * A refused project write. `message` is the caller-facing reason, carried here
 * so a route never has to infer it from `status`.
 */
type ProjectWriteError = {
  status: typeof Status.BadRequest;
  message: string;
};

const ASSIGNEE_NOT_IN_ORGANIZATION: ProjectWriteError = {
  status: Status.BadRequest,
  message: USER_NOT_IN_ORGANIZATION_MESSAGE,
};

type UpdatedProject = {
  project: PrismaProject;
  previous: ProjectBeforeImage | null;
};

/** What a recorded project update wrote, for its receipt (ISS-12552). */
type UpdatedProjectWrite = UpdatedProject & {
  /** The columns, and the team set, this write actually moved. */
  changedFields: string[];
};

/**
 * Whether `assigneeId` may be written on a project in `organizationId`, so a
 * project can only ever be assigned to a user the caller can already see — the
 * same rule `resolveOrgTeamIds` applies above, and the one `documentsService`
 * already applies to an artifact's assignee.
 *
 * `projects.assignee_id` has a real FK to `users.id`, so the column alone
 * cannot express this: a user in ANOTHER organization satisfies it. Without
 * this check the write commits, `findById` then projects that foreign user's
 * name and avatar into the org's project list, and the route's assignment
 * notification is dispatched to them.
 *
 * `undefined` leaves the column untouched and `null` clears it; neither names a
 * user, so neither is looked up.
 */
async function isAssignableInOrg(
  assigneeId: string | null | undefined,
  organizationId: string
): Promise<boolean> {
  if (!assigneeId) {
    return true;
  }
  return await withDb((db) =>
    isUserInOrganization(db, assigneeId, organizationId)
  );
}

/**
 * The first guard the locked row refutes, or null. The description is compared
 * as rendered, an unset one as `""`, because that is what the client read.
 */
function staleProjectField(
  projectId: string,
  previous: ProjectBeforeImage,
  input: Omit<UpdateProjectInput, "id">
): ProjectFieldMutationError | null {
  const { expectedName, expectedDescription } = input;
  if (
    expectedName !== undefined &&
    isStaleExpectation(previous.name, input.name, expectedName)
  ) {
    return staleProjectNameConflict({
      projectId,
      currentName: previous.name,
      expectedName,
    });
  }
  const currentDescription = previous.description ?? "";
  if (
    expectedDescription !== undefined &&
    isStaleExpectation(
      currentDescription,
      input.description,
      expectedDescription
    )
  ) {
    return staleProjectDescriptionConflict({
      projectId,
      currentDescription,
      expectedDescription,
    });
  }
  return null;
}

/** Replaces the project's teams; whether the set of teams changed. */
async function replaceProjectTeams(
  tx: Prisma.TransactionClient,
  projectId: string,
  teamIds: string[],
  organizationId: string
): Promise<boolean> {
  const resolvedTeamIds = await resolveOrgTeamIds(tx, teamIds, organizationId);
  const current = await tx.projectTeam.findMany({
    where: { projectId },
    select: { teamId: true },
  });
  await tx.projectTeam.deleteMany({ where: { projectId } });
  if (resolvedTeamIds.length > 0) {
    await tx.projectTeam.createMany({
      data: resolvedTeamIds.map((teamId) => ({ projectId, teamId })),
      skipDuplicates: true,
    });
  }
  const before = new Set(current.map((row) => row.teamId));
  const after = new Set(resolvedTeamIds);
  return before.size !== after.size || [...after].some((id) => !before.has(id));
}
