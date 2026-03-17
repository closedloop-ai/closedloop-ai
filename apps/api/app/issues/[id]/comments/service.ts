import { EntityType } from "@repo/api/src/types/entity-link";
import { withDb } from "@repo/database";

export const issueCommentsService = {
  findIssue(id: string, organizationId: string) {
    return withDb((db) =>
      db.issue.findFirst({
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
          entityType: EntityType.Issue,
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
