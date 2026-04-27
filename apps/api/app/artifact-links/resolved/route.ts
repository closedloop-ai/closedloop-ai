import {
  type ArtifactLinkWithEndpoints,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { artifactLinksService } from "../service";
import { findArtifactLinksQueryValidator } from "../validators";

export const GET = withAnyAuth<
  ArtifactLinkWithEndpoints[],
  "/artifact-links/resolved"
>(async ({ user }, request) => {
  try {
    const { params, errorResponse: parseError } = parseQueryParams(
      request,
      findArtifactLinksQueryValidator
    );
    if (parseError) {
      return parseError;
    }

    const { artifactId, linkType, direction, mode, maxDepth } = params;

    const resolvedArtifactId = await resolveArtifactIdentifier(
      artifactId,
      user.organizationId
    );
    if (!resolvedArtifactId) {
      return notFoundResponse("Artifact");
    }

    // Tree mode: traverse the graph via findLinkTree first (feature → plan →
    // PR → deployment) and hydrate endpoint objects for every link id the
    // traversal collected. Direct mode keeps the single-hop behavior.
    if (mode === LinkQueryMode.Tree) {
      const resolved = await artifactLinksService.findResolvedLinkTree(
        user.organizationId,
        resolvedArtifactId,
        direction,
        maxDepth,
        linkType
      );
      return successResponse(resolved);
    }

    const resolved = await artifactLinksService.findResolvedLinks(
      user.organizationId,
      resolvedArtifactId,
      direction,
      linkType
    );

    return successResponse(resolved);
  } catch (error) {
    return errorResponse("Failed to fetch resolved artifact links", error);
  }
});
