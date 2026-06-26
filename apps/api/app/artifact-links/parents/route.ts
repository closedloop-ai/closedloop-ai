import type { ArtifactParentProjection } from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { artifactLinksService } from "../service";
import { findArtifactParentsQueryValidator } from "../validators";

/**
 * GET /artifact-links/parents returns a selected direct-parent projection for
 * each requested target artifact id. Full lineage remains on /artifact-links
 * and /artifact-links/resolved direct/tree APIs.
 */
export const GET = withAnyAuth<
  ArtifactParentProjection[],
  "/artifact-links/parents"
>(async ({ user }, request) => {
  try {
    const { params, errorResponse: parseError } = parseQueryParams(
      request,
      findArtifactParentsQueryValidator
    );
    if (parseError) {
      return parseError;
    }

    const projections =
      await artifactLinksService.findSelectedParentProjections(
        user.organizationId,
        params.targetIds,
        { linkType: params.linkType }
      );

    return successResponse(projections);
  } catch (error) {
    return errorResponse("Failed to fetch artifact parents", error);
  }
});
