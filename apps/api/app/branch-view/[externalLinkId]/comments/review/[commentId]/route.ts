import {
  BranchViewCommentAction,
  type BranchViewCommentActionResult,
} from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import {
  deleteBranchViewCommentRequestSchema,
  updateBranchViewCommentRequestSchema,
} from "../../../schemas";
import {
  actionResultResponse,
  invalidCommentActionResult,
  parseCommentActionBody,
} from "../../action-route-utils";
import {
  deleteReviewComment,
  editReviewComment,
} from "../../direct-write-service";

/**
 * Edit an existing projected GitHub review comment through the authenticated
 * user's GitHub token, using last-write-wins provider semantics.
 */
export const PATCH = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/review/[commentId]"
>(async (auth, request, params) => {
  try {
    const { commentId, externalLinkId } = await params;
    const { body, response: parseError } = await parseCommentActionBody(
      request,
      updateBranchViewCommentRequestSchema,
      (message) =>
        invalidCommentActionResult({
          action: BranchViewCommentAction.Edit,
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
      await editReviewComment({
        ctx,
        user: auth.user,
        auth,
        commentId,
        body: body.body,
      })
    );
  } catch (error) {
    return errorResponse("Failed to edit comment", error);
  }
});

/**
 * Delete an existing projected GitHub review comment and make repeated local
 * deletes idempotent after the projection is marked deleted.
 */
export const DELETE = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/review/[commentId]"
>(async (auth, request, params) => {
  try {
    const { commentId, externalLinkId } = await params;
    const { response: parseError } = await parseCommentActionBody(
      request,
      deleteBranchViewCommentRequestSchema,
      (message) =>
        invalidCommentActionResult({
          action: BranchViewCommentAction.Delete,
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
      await deleteReviewComment({
        ctx,
        user: auth.user,
        auth,
        commentId,
      })
    );
  } catch (error) {
    return errorResponse("Failed to delete comment", error);
  }
});
