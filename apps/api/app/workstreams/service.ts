import type {
  CreateWorkstreamInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamState,
  WorkstreamWithProject,
} from "@repo/api/src/types/workstream";
import { withDb } from "@repo/database";
import type { WorkstreamUpdateInput } from "@repo/database/generated/models";
import { basicUserSelect } from "@/lib/db-utils";
import { generateSlug, SlugPrefix } from "@/lib/slug-generator";

export type FindWorkstreamsOptions = {
  organizationId: string;
  projectId: string;
  state?: WorkstreamState;
  search?: string;
  limit?: number;
};

export type FindAllByOrganizationOptions = {
  excludeStates?: WorkstreamState[];
};

/**
 * Workstreams service - handles database operations for workstream management
 */
export const workstreamsService = {
  /**
   * Find all workstreams for a project with optional filters
   */
  findByProject(options: FindWorkstreamsOptions): Promise<Workstream[]> {
    const { organizationId, projectId, state, search, limit } = options;

    return withDb((db) =>
      db.workstream.findMany({
        where: {
          organizationId,
          projectId,
          ...(state ? { state } : {}),
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" } },
                  { description: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        include: {
          createdBy: basicUserSelect,
        },
        orderBy: { createdAt: "desc" },
        ...(limit ? { take: limit } : {}),
      })
    );
  },

  /**
   * Find a workstream by ID (scoped to organization via project)
   */
  findById(id: string, organizationId: string): Promise<Workstream | null> {
    return withDb((db) =>
      db.workstream.findUnique({
        where: { id, organizationId },
        include: {
          createdBy: basicUserSelect,
        },
      })
    );
  },

  /**
   * Find all workstreams for an organization across all projects
   * Excludes terminal states (COMPLETED, CANCELLED, DEPLOYED) by default
   */
  findAllByOrganization(
    organizationId: string,
    options: FindAllByOrganizationOptions = {}
  ): Promise<WorkstreamWithProject[]> {
    const excludeStates = options.excludeStates ?? [
      "COMPLETED" as WorkstreamState,
      "CANCELLED" as WorkstreamState,
      "DEPLOYED" as WorkstreamState,
    ];

    return withDb((db) =>
      db.workstream.findMany({
        where: {
          organizationId,
          state: { notIn: excludeStates },
        },
        include: {
          createdBy: basicUserSelect,
          project: {
            select: { name: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      })
    );
  },

  /**
   * Create a new workstream
   */
  async create(
    organizationId: string,
    createdById: string,
    input: CreateWorkstreamInput
  ): Promise<Workstream> {
    const generatedSlug = await generateSlug(
      organizationId,
      SlugPrefix.Workstream
    );

    return withDb((db) =>
      db.workstream.create({
        data: {
          ...input,
          slug: generatedSlug,
          organizationId,
          createdById,
        },
        include: {
          createdBy: basicUserSelect,
        },
      })
    );
  },

  /**
   * Update an existing workstream
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateWorkstreamInput, "id">
  ): Promise<Workstream> {
    // If state is being changed, update stateChangedAt
    const data: Omit<UpdateWorkstreamInput, "id"> &
      Pick<WorkstreamUpdateInput, "stateChangedAt"> = { ...input };
    if (input.state) {
      data.stateChangedAt = new Date();
    }

    return withDb((db) =>
      db.workstream.update({
        where: { id, organizationId },
        data,
        include: {
          createdBy: basicUserSelect,
        },
      })
    );
  },

  /**
   * Delete a workstream (scoped to organization via project)
   */
  delete(id: string, organizationId: string): Promise<void> {
    return withDb(async (db) => {
      await db.workstream.delete({
        where: { id, organizationId },
      });
    });
  },
};
