import { withDb } from "@repo/database";

export const issueCommentsService = {
  findIssue(id: string, organizationId: string) {
    return withDb((db) =>
      db.issue.findFirst({
        where: { id, organizationId },
        select: { id: true, workstreamId: true },
      })
    );
  },

  create(workstreamId: string, authorId: string, content: string) {
    return withDb((db) =>
      db.comment.create({
        data: { workstreamId, authorId, content },
      })
    );
  },
};
