import type {
  BranchViewCommentActionResult,
  CreateBranchViewConversationCommentRequest,
} from "@repo/api/src/types/branch-view";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
} from "@/lib/route-utils";
import { createBranchViewConversationCommentRequestSchema } from "../../schemas";
import { branchViewCommentActionResponse } from "../action-response";
import { branchViewConversationService } from "../conversation-service";

export const POST = withAnyAuth<
  BranchViewCommentActionResult,
  "/branch-view/[externalLinkId]/comments/conversation"
>(async ({ apiKeyScopes, authMethod, user }, request, params) => {
  try {
    const { externalLinkId } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createBranchViewConversationCommentRequestSchema
    );
    if (parseError) {
      return parseError;
    }

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const response = await branchViewConversationService.create({
      ctx,
      user,
      auth: { authMethod, organizationId: user.organizationId, apiKeyScopes },
      body: (body as CreateBranchViewConversationCommentRequest).body,
    });
    scheduleLogFlush();
    return branchViewCommentActionResponse(
      response.result,
      response.httpStatus
    );
  } catch (error) {
    return errorResponse("Failed to create PR conversation comment", error);
  }
});
