import type {
  CreateWorkstreamInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { withDb } from "@repo/database";
import type { WorkstreamUpdateInput } from "@repo/database/generated/models";

export type FindWorkstreamsOptions = {
  organizationId: string;
  projectId: string;
  state?: WorkstreamState;
  search?: string;
  limit?: number;
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
      })
    );
  },

  /**
   * Create a new workstream
   */
  create(
    organizationId: string,
    createdById: string,
    input: CreateWorkstreamInput
  ): Promise<Workstream> {
    return withDb((db) =>
      db.workstream.create({
        data: {
          organizationId,
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          type: input.type ?? "FEATURE_DELIVERY",
          createdById,
          assignedToId: input.assignedToId,
          hasUIChanges: input.hasUIChanges ?? false,
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
    const data: WorkstreamUpdateInput = { ...input };
    if (input.state) {
      data.stateChangedAt = new Date();
    }

    return withDb((db) =>
      db.workstream.update({
        where: { id, organizationId },
        data,
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
