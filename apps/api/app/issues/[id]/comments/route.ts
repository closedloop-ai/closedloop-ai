import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { issueCommentsService } from "./service";

const createCommentValidator = z.object({
  body: z.string().min(1),
});

/**
 * POST /issues/:id/comments
 *
 * Creates a comment on an issue. If the issue belongs to a workstream,
 * the comment is stored in the comments table. Otherwise, the request
 * is acknowledged but the comment is not persisted (no workstream context).
 */
export const POST = withAnyAuth<{ created: boolean }, "/issues/[id]/comments">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createCommentValidator
      );
      if (parseError) {
        return parseError;
      }

      // Look up the issue to get its workstreamId
      const issue = await issueCommentsService.findIssue(
        id,
        user.organizationId
      );

      if (!issue) {
        return errorResponse("Issue not found", null, 404);
      }

      // Only persist if the issue has a workstream (Comment requires workstreamId)
      if (issue.workstreamId) {
        await issueCommentsService.create(
          issue.workstreamId,
          user.id,
          body.body
        );
      }

      return successResponse({ created: !!issue.workstreamId });
    } catch (error) {
      return errorResponse("Failed to create comment", error);
    }
  }
);
