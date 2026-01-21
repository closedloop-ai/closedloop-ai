import type {
  CreateWorkstreamInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamState,
} from "@repo/api/src/types/workstream";
import { database } from "@repo/database";
import type { WorkstreamUpdateInput } from "@repo/database/generated/models";

export type FindWorkstreamsOptions = {
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
  async findByProject(options: FindWorkstreamsOptions): Promise<Workstream[]> {
    const { projectId, state, search, limit } = options;

    return await database.workstream.findMany({
      where: {
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
    });
  },

  /**
   * Find a workstream by ID (scoped to organization via project)
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<Workstream | null> {
    return await database.workstream.findUnique({
      where: { id, project: { organizationId } },
    });
  },

  /**
   * Create a new workstream
   */
  async create(
    createdById: string,
    input: CreateWorkstreamInput
  ): Promise<Workstream> {
    return await database.workstream.create({
      data: {
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        type: input.type ?? "FEATURE_DELIVERY",
        createdById,
        assignedToId: input.assignedToId,
        hasUIChanges: input.hasUIChanges ?? false,
      },
    });
  },

  /**
   * Update an existing workstream
   */
  async update(
    id: string,
    input: Omit<UpdateWorkstreamInput, "id">
  ): Promise<Workstream> {
    // If state is being changed, update stateChangedAt
    const data: WorkstreamUpdateInput = { ...input };
    if (input.state) {
      data.stateChangedAt = new Date();
    }

    return await database.workstream.update({
      where: { id },
      data,
    });
  },

  /**
   * Delete a workstream (scoped to organization via project)
   */
  async delete(id: string, organizationId: string): Promise<void> {
    await database.workstream.delete({
      where: { id, project: { organizationId } },
    });
  },
};
