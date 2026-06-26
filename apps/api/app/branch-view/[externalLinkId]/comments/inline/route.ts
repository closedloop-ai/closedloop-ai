import {
  BranchViewCommentAction,
  type BranchViewCommentActionResult,
} from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { createBranchViewInlineCommentRequestSchema } from "../../schemas";
import {
  actionResultResponse,
  invalidCommentActionResult,
  parseCommentActionBody,
} from "../action-route-utils";
import { createInlineReviewComment } from "../direct-write-service";

/**
 * Create a GitHub inline review comment from a validated branch-view diff
 * anchor using the authenticated user's GitHub write identity.
 */
export const POST = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/inline"
>(async (auth, request, params) => {
  try {
    const { externalLinkId } = await params;
    const { body, response: parseError } = await parseCommentActionBody(
      request,
      createBranchViewInlineCommentRequestSchema,
      (message) =>
        invalidCommentActionResult({
          action: BranchViewCommentAction.CreateInline,
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
      await createInlineReviewComment({
        ctx,
        user: auth.user,
        auth,
        request: body,
      })
    );
  } catch (error) {
    return errorResponse("Failed to create inline comment", error);
  }
});
