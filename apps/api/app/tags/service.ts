import type {
  CreateTagInput,
  TagEntityType as TagEntityTypeValue,
  TagSummary,
  UpdateTagInput,
} from "@repo/api/src/types/tag";
import { TAG_COLORS, TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { basicUserSelect, getPrismaErrorCode } from "@/lib/db-utils";

export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`A tag named "${name}" already exists in this organization.`);
    this.name = "DuplicateNameError";
  }
}

export const TAG_SUMMARY_SELECT = {
  id: true,
  name: true,
  color: true,
} as const;

export const TAG_RELATION_INCLUDE = {
  tag: { select: TAG_SUMMARY_SELECT },
} as const;

export function mapTagRelations(
  relations: Array<{ tag: { id: string; name: string; color: string } }>
) {
  return relations.map((r) => r.tag) as TagSummary[];
}

const TAG_INCLUDE = {
  createdBy: basicUserSelect,
  _count: {
    select: {
      tagProjects: true,
      tagArtifacts: true,
      tagLoops: true,
    },
  },
} as const;

export const tagService = {
  findByOrg(organizationId: string) {
    return withDb((db) =>
      db.tag.findMany({
        where: { organizationId },
        include: TAG_INCLUDE,
        orderBy: { name: "asc" },
      })
    );
  },

  async create(organizationId: string, userId: string, input: CreateTagInput) {
    const existing = await withDb((db) =>
      db.tag.findFirst({
        where: {
          organizationId,
          name: { equals: input.name, mode: "insensitive" },
        },
        select: { id: true },
      })
    );
    if (existing) {
      throw new DuplicateNameError(input.name);
    }

    const color = input.color ?? (await pickDefaultColor(organizationId));

    try {
      return await withDb((db) =>
        db.tag.create({
          data: {
            organizationId,
            createdById: userId,
            name: input.name,
            color,
          },
          include: TAG_INCLUDE,
        })
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name);
      }
      throw error;
    }
  },

  async update(id: string, organizationId: string, input: UpdateTagInput) {
    if (input.name) {
      const existing = await withDb((db) =>
        db.tag.findFirst({
          where: {
            organizationId,
            name: { equals: input.name, mode: "insensitive" },
            id: { not: id },
          },
          select: { id: true },
        })
      );
      if (existing) {
        throw new DuplicateNameError(input.name);
      }
    }

    try {
      return await withDb((db) =>
        db.tag.update({
          where: { id, organizationId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.color === undefined ? {} : { color: input.color }),
          },
          include: TAG_INCLUDE,
        })
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        throw new EntityNotFoundError("Tag", id);
      }
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name ?? "");
      }
      throw error;
    }
  },

  async delete(id: string, organizationId: string) {
    try {
      await withDb((db) => db.tag.delete({ where: { id, organizationId } }));
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        throw new EntityNotFoundError("Tag", id);
      }
      throw error;
    }
  },

  async getArtifactCount(id: string, organizationId: string) {
    await validateTagOwnership(id, organizationId);
    const [projects, artifacts, loops] = await Promise.all([
      withDb((db) => db.tagProject.count({ where: { tagId: id } })),
      withDb((db) => db.tagArtifact.count({ where: { tagId: id } })),
      withDb((db) => db.tagLoop.count({ where: { tagId: id } })),
    ]);
    return projects + artifacts + loops;
  },

  async applyTag(
    tagId: string,
    entityType: TagEntityTypeValue,
    entityId: string,
    organizationId: string
  ) {
    try {
      // Validate ownership/existence and write in one transaction so a
      // concurrently deleted entity cannot pass validation and then leave a
      // phantom row (TOCTOU). The inner withDb() calls in the validators join
      // this ambient transaction.
      await withDb.tx(async () => {
        await validateTagOwnership(tagId, organizationId);
        await validateEntityExists(entityType, entityId, organizationId);

        switch (entityType) {
          case TagEntityType.Project:
            await withDb((db) =>
              db.tagProject.create({ data: { tagId, projectId: entityId } })
            );
            break;
          case TagEntityType.Artifact:
            await withDb((db) =>
              db.tagArtifact.create({ data: { tagId, artifactId: entityId } })
            );
            break;
          case TagEntityType.Loop:
            await withDb((db) =>
              db.tagLoop.create({ data: { tagId, loopId: entityId } })
            );
            break;
          default:
            throw new Error(`Unknown entity type: ${entityType as string}`);
        }
      });
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        return;
      }
      // P2003: the entity was deleted between validation and insert, so the
      // foreign key no longer resolves. Fail gracefully as not-found.
      if (getPrismaErrorCode(error) === "P2003") {
        throw new EntityNotFoundError(entityType, entityId);
      }
      throw error;
    }
  },

  async batchApplyTag(
    tagId: string,
    // Artifact-only: this writes `tagArtifact` rows. The validator and the
    // shared `BatchApplyTagInput` contract both pin `entityType` to Artifact,
    // so project/loop ids can never reach this write against the wrong relation.
    _entityType: typeof TagEntityType.Artifact,
    entityIds: string[],
    organizationId: string
  ) {
    await validateTagOwnership(tagId, organizationId);

    const uniqueIds = [...new Set(entityIds)];

    // Validate all entities exist in the org before writing. Any artifact
    // type is taggable.
    const existing = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      })
    );
    if (existing.length !== uniqueIds.length) {
      const foundIds = new Set(existing.map((e) => e.id));
      const missing = uniqueIds.filter((id) => !foundIds.has(id));
      throw new EntityNotFoundError("Artifact", missing.join(", "));
    }

    // Use createMany with skipDuplicates for idempotency
    const result = await withDb((db) =>
      db.tagArtifact.createMany({
        data: uniqueIds.map((entityId) => ({
          tagId,
          artifactId: entityId,
        })),
        skipDuplicates: true,
      })
    );

    return { appliedCount: result.count };
  },

  async removeTag(
    tagId: string,
    entityType: TagEntityTypeValue,
    entityId: string,
    organizationId: string
  ) {
    await validateTagOwnership(tagId, organizationId);
    switch (entityType) {
      case TagEntityType.Project:
        await withDb((db) =>
          db.tagProject.deleteMany({ where: { tagId, projectId: entityId } })
        );
        break;
      case TagEntityType.Artifact:
        await withDb((db) =>
          db.tagArtifact.deleteMany({ where: { tagId, artifactId: entityId } })
        );
        break;
      case TagEntityType.Loop:
        await withDb((db) =>
          db.tagLoop.deleteMany({ where: { tagId, loopId: entityId } })
        );
        break;
      default:
        throw new Error(`Unknown entity type: ${entityType as string}`);
    }
  },
};

async function pickDefaultColor(organizationId: string): Promise<string> {
  const count = await withDb((db) =>
    db.tag.count({ where: { organizationId } })
  );
  return TAG_COLORS[count % TAG_COLORS.length];
}

async function validateEntityExists(
  entityType: TagEntityTypeValue,
  entityId: string,
  organizationId: string
): Promise<void> {
  let exists = false;

  switch (entityType) {
    case TagEntityType.Project:
      exists = !!(await withDb((db) =>
        db.project.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        })
      ));
      break;
    // Any artifact type is taggable (documents, branches, deployments,
    // sessions) — tags are common artifact plumbing, so validation is
    // existence + org-scoping only.
    case TagEntityType.Artifact:
      exists = !!(await withDb((db) =>
        db.artifact.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        })
      ));
      break;
    case TagEntityType.Loop:
      exists = !!(await withDb((db) =>
        db.loop.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        })
      ));
      break;
    default:
      throw new Error(`Unknown entity type: ${entityType as string}`);
  }

  if (!exists) {
    throw new EntityNotFoundError(entityType, entityId);
  }
}

async function validateTagOwnership(
  tagId: string,
  organizationId: string
): Promise<void> {
  const tag = await withDb((db) =>
    db.tag.findFirst({
      where: { id: tagId, organizationId },
      select: { id: true },
    })
  );
  if (!tag) {
    throw new EntityNotFoundError("Tag", tagId);
  }
}

export class EntityNotFoundError extends Error {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} not found in this organization`);
    this.name = "EntityNotFoundError";
  }
}
