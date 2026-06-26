import {
  type BranchViewComment,
  BranchViewCommentAction,
} from "@repo/api/src/types/branch-view";
import type { ApiResult } from "@repo/api/src/types/common";
import type { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { replyToBranchViewCommentRequestSchema } from "../../schemas";
import {
  actionFailureResponse,
  invalidCommentActionResult,
  parseCommentActionBody,
} from "../action-route-utils";
import { replyToReviewComment } from "../direct-write-service";

/**
 * Reply to a GitHub review comment while preserving the existing branch-view
 * `{ commentGithubId, body }` request contract.
 */
export const POST = withAnyAuth<
  BranchViewComment,
  "/branch-view/[externalLinkId]/comments/reply"
>(async (auth, request, params) => {
  try {
    const { externalLinkId } = await params;

    const { body, response: parseError } = await parseCommentActionBody(
      request,
      replyToBranchViewCommentRequestSchema,
      (message) =>
        invalidCommentActionResult({
          action: BranchViewCommentAction.Reply,
          message,
        })
    );
    if (parseError) {
      return parseError as NextResponse<ApiResult<BranchViewComment>>;
    }

    const ctx = await resolvePrContext(
      externalLinkId,
      auth.user.organizationId
    );
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const result = await replyToReviewComment({
      ctx,
      user: auth.user,
      auth,
      commentGithubId: body.commentGithubId,
      body: body.body,
    });
    if (!result.success) {
      return actionFailureResponse(result);
    }
    return successResponse(result.comment);
  } catch (error) {
    return errorResponse("Failed to reply to comment", error);
  }
});
