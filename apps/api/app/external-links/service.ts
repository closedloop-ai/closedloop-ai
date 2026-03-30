import type { JsonObject } from "@repo/api/src/types/common";
import type {
  CreateExternalLinkInput,
  ExternalLink,
  FindExternalLinksOptions,
  UpdateExternalLinkInput,
} from "@repo/api/src/types/external-link";
import { Prisma, withDb } from "@repo/database";

export const externalLinksService = {
  toExternalLink(link: Prisma.ExternalLinkModel): ExternalLink {
    return {
      ...link,
      metadata: link.metadata as JsonObject | null,
    };
  },

  findAll(
    options: FindExternalLinksOptions & { organizationId: string }
  ): Promise<ExternalLink[]> {
    const { organizationId, workstreamId, projectId, type } = options;

    return withDb((db) =>
      db.externalLink.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toExternalLink));
  },

  findById(id: string, organizationId: string): Promise<ExternalLink | null> {
    return withDb((db) =>
      db.externalLink.findFirst({
        where: { id, organizationId },
      })
    ).then((link) => (link ? this.toExternalLink(link) : null));
  },

  findByWorkstream(
    workstreamId: string,
    type?: ExternalLink["type"]
  ): Promise<ExternalLink[]> {
    return withDb((db) =>
      db.externalLink.findMany({
        where: {
          workstreamId,
          ...(type ? { type } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
    ).then((links) => links.map(this.toExternalLink));
  },

  create(
    organizationId: string,
    input: CreateExternalLinkInput
  ): Promise<ExternalLink> {
    return withDb((db) =>
      db.externalLink.create({
        data: {
          ...input,
          organizationId,
          metadata: input.metadata ?? Prisma.DbNull,
        },
      })
    ).then((link) => this.toExternalLink(link));
  },

  update(
    organizationId: string,
    id: string,
    input: Omit<UpdateExternalLinkInput, "id">
  ): Promise<ExternalLink> {
    const metadata =
      input.metadata === undefined
        ? undefined
        : (input.metadata ?? Prisma.DbNull);
    return withDb((db) =>
      db.externalLink.update({
        where: { id, organizationId },
        data: {
          ...input,
          metadata,
        },
      })
    ).then((link) => this.toExternalLink(link));
  },

  async delete(organizationId: string, id: string): Promise<void> {
    await withDb.tx(async (tx) => {
      await tx.entityLink.deleteMany({
        where: {
          organizationId,
          OR: [
            { sourceId: id, sourceType: "EXTERNAL_LINK" },
            { targetId: id, targetType: "EXTERNAL_LINK" },
          ],
        },
      });
      await tx.externalLink.delete({ where: { id, organizationId } });
    });
  },
};
