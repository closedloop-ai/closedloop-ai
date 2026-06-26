import {
  BranchViewCommentAction,
  type BranchViewCommentActionResult,
} from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { unresolveBranchViewCommentRequestSchema } from "../../../../schemas";
import {
  actionResultResponse,
  invalidCommentActionResult,
  parseCommentActionBody,
} from "../../../action-route-utils";
import { unresolveReviewThread } from "../../../direct-write-service";

/**
 * Reopen an inline GitHub review thread through the caller's GitHub user token.
 */
export const POST = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/review/[commentId]/unresolve"
>(async (auth, request, params) => {
  try {
    const { commentId, externalLinkId } = await params;
    const { response: parseError } = await parseCommentActionBody(
      request,
      unresolveBranchViewCommentRequestSchema,
      (message) =>
        invalidCommentActionResult({
          action: BranchViewCommentAction.Unresolve,
          message,
        })
    );
    if (parseError) {
      return parseError;
    }

    const ctx = await resolvePrContext(
      externalLinkId,
      auth.user.organizationId
    );
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    return actionResultResponse(
      await unresolveReviewThread({
        auth,
        commentId,
        ctx,
        user: auth.user,
      })
    );
  } catch (error) {
    return errorResponse("Failed to unresolve review thread", error);
  }
});
