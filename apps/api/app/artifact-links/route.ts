import { type ArtifactLink, LinkQueryMode } from "@repo/api/src/types/artifact";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactIdentifier } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { artifactLinksService } from "./service";
import {
  createArtifactLinkValidator,
  findArtifactLinksQueryValidator,
} from "./validators";

export const GET = withAnyAuth<ArtifactLink[], "/artifact-links">(
  async ({ user }, request) => {
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

      if (mode === LinkQueryMode.Tree) {
        const annotatedLinks = await artifactLinksService.findLinkTree(
          user.organizationId,
          resolvedArtifactId,
          direction,
          maxDepth,
          linkType
        );
        return successResponse(annotatedLinks.map((a) => a.link));
      }

      const links = await artifactLinksService.findLinksByDirection(
        user.organizationId,
        resolvedArtifactId,
        direction,
        linkType
      );

      return successResponse(links);
    } catch (error) {
      return errorResponse("Failed to fetch artifact links", error);
    }
  }
);

export const POST = withAnyAuth<ArtifactLink, "/artifact-links">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactLinkValidator
      );
      if (parseError) {
        return parseError;
      }

      const resolvedSourceId = await resolveArtifactIdentifier(
        body.sourceId,
        user.organizationId
      );
      if (!resolvedSourceId) {
        return notFoundResponse("Source artifact");
      }
      const resolvedTargetId = await resolveArtifactIdentifier(
        body.targetId,
        user.organizationId
      );
      if (!resolvedTargetId) {
        return notFoundResponse("Target artifact");
      }

      const link = await artifactLinksService.createLink(user.organizationId, {
        linkType: body.linkType,
        metadata: body.metadata,
        sourceId: resolvedSourceId,
        targetId: resolvedTargetId,
      });

      return successResponse(link);
    } catch (error) {
      return errorResponse("Failed to create artifact link", error);
    }
  },
  { requiredScopes: ["write"] }
);
