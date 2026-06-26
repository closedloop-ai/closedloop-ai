import type { BranchViewCommentActionResult } from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
} from "@/lib/route-utils";
import { updateBranchViewCommentRequestSchema } from "../../schemas";
import { branchViewCommentActionResponse } from "../action-response";
import { branchViewConversationService } from "../conversation-service";

export const PATCH = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/[githubCommentId]"
>(async ({ apiKeyScopes, authMethod, user }, request, params) => {
  try {
    const { externalLinkId, githubCommentId } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateBranchViewCommentRequestSchema
    );
    if (!body || parseError) {
      return parseError ?? errorResponse("Unexpected parse state", null);
    }

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const response = await branchViewConversationService.edit({
      ctx,
      user,
      auth: { authMethod, organizationId: user.organizationId, apiKeyScopes },
      githubCommentId,
      body: body.body,
    });
    scheduleLogFlush();
    return branchViewCommentActionResponse(
      response.result,
      response.httpStatus
    );
  } catch (error) {
    return errorResponse("Failed to edit PR conversation comment", error);
  }
});

export const DELETE = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/[githubCommentId]"
>(async ({ apiKeyScopes, authMethod, user }, _request, params) => {
  try {
    const { externalLinkId, githubCommentId } = await params;

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const response = await branchViewConversationService.delete({
      ctx,
      user,
      auth: { authMethod, organizationId: user.organizationId, apiKeyScopes },
      githubCommentId,
    });
    scheduleLogFlush();
    return branchViewCommentActionResponse(
      response.result,
      response.httpStatus
    );
  } catch (error) {
    return errorResponse("Failed to delete PR conversation comment", error);
  }
});
