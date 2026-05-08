import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { z } from "zod/v4";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolvePrContext } from "@/lib/resolve-pr-context";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { replyToComment } from "./service";

const replyValidator = z.object({
  commentGithubId: z.number(),
  body: z.string().min(1),
});

export const POST = withAnyAuth<
  BranchViewComment,
  "/branch-view/[externalLinkId]/comments/reply"
>(async ({ user }, request, params) => {
  try {
    const { externalLinkId } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      replyValidator
    );
    if (parseError) {
      return parseError;
    }

    const ctx = await resolvePrContext(externalLinkId, user.organizationId);
    if (!ctx) {
      return notFoundResponse("Branch view");
    }

    const result = await replyToComment(ctx, body.commentGithubId, body.body);
    if (result.error || !result.data) {
      return errorResponse(result.error ?? "Reply failed", result.error);
    }

    return successResponse(result.data);
  } catch (error) {
    return errorResponse("Failed to reply to comment", error);
  }
});
