import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveIssueId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
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
      const resolvedId = await resolveIssueId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Issue");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createCommentValidator
      );
      if (parseError) {
        return parseError;
      }

      // Look up the issue to get its workstreamId
      const issue = await issueCommentsService.findIssue(
        resolvedId,
        user.organizationId
      );

      if (!issue) {
        return errorResponse("Issue not found", null, 404);
      }

      await issueCommentsService.create(
        issue.organizationId,
        user.id,
        resolvedId,
        body.body
      );

      return successResponse({ created: true });
    } catch (error) {
      return errorResponse("Failed to create comment", error);
    }
  }
);
