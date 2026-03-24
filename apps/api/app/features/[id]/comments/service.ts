import { EntityType } from "@repo/api/src/types/entity-link";
import { withDb } from "@repo/database";

export const featureCommentsService = {
  findFeature(id: string, organizationId: string) {
    return withDb((db) =>
      db.feature.findFirst({
        where: { id, organizationId },
        select: { id: true, workstreamId: true, organizationId: true },
      })
    );
  },

  create(
    organizationId: string,
    authorId: string,
    entityId: string,
    content: string
  ) {
    return withDb((db) =>
      db.commentThread.create({
        data: {
          organizationId,
          entityId,
          entityType: EntityType.Feature,
          createdById: authorId,
          comments: {
            create: {
              authorId,
              body: {
                version: 1,
                content: [{ type: "paragraph", children: [{ text: content }] }],
              },
              plainText: content,
            },
          },
        },
        include: { comments: true },
      })
    );
  },
};
