import type { EntityLink } from "@repo/api/src/types/entity-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { EntityOrganizationMismatchError, entityLinksService } from "./service";
import {
  createEntityLinkValidator,
  findEntityLinksQueryValidator,
} from "./validators";

export const GET = withAnyAuth<EntityLink[], "/entity-links">(
  async ({ user }, request) => {
    try {
      const { params, errorResponse } = parseQueryParams(
        request,
        findEntityLinksQueryValidator
      );
      if (errorResponse) {
        return errorResponse;
      }

      const { entityId, entityType, linkType, direction, mode, maxDepth } =
        params;

      if (mode === "tree") {
        const annotatedLinks = await entityLinksService.findLinkTree(
          user.organizationId,
          entityId,
          entityType,
          direction,
          maxDepth,
          linkType
        );
        return successResponse(annotatedLinks.map((a) => a.link));
      }

      const links = await entityLinksService.findLinksByDirection(
        user.organizationId,
        entityId,
        entityType,
        direction,
        linkType
      );

      return successResponse(links);
    } catch (error) {
      return errorResponse("Failed to fetch entity links", error);
    }
  }
);

export const POST = withAnyAuth<EntityLink, "/entity-links">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createEntityLinkValidator
      );
      if (parseError) {
        return parseError;
      }

      const link = await entityLinksService.createLink(
        user.organizationId,
        body
      );

      return successResponse(link);
    } catch (error) {
      if (error instanceof EntityOrganizationMismatchError) {
        return forbiddenResponse();
      }
      return errorResponse("Failed to create entity link", error);
    }
  },
  { requiredScopes: ["write"] }
);
