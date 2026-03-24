import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { featureCommentsService } from "./service";

const createCommentValidator = z.object({
  body: z.string().min(1),
});

/**
 * POST /features/:id/comments
 *
 * Creates a comment on a feature. If the feature belongs to a workstream,
 * the comment is stored in the comments table. Otherwise, the request
 * is acknowledged but the comment is not persisted (no workstream context).
 */
export const POST = withAnyAuth<
  { created: boolean },
  "/features/[id]/comments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveFeatureId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Feature");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createCommentValidator
    );
    if (parseError) {
      return parseError;
    }

    // Look up the feature to get its workstreamId
    const feature = await featureCommentsService.findFeature(
      resolvedId,
      user.organizationId
    );

    if (!feature) {
      return errorResponse("Feature not found", null, 404);
    }

    await featureCommentsService.create(
      feature.organizationId,
      user.id,
      resolvedId,
      body.body
    );

    return successResponse({ created: true });
  } catch (error) {
    return errorResponse("Failed to create comment", error);
  }
});
