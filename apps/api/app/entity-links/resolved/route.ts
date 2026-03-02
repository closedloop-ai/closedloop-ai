import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import type { AnnotatedLink } from "../service";
import { entityLinksService } from "../service";
import { findEntityLinksQueryValidator } from "../validators";

export const GET = withAnyAuth<LinkedEntity[], "/entity-links/resolved">(
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

      let annotatedLinks: AnnotatedLink[];

      if (mode === "tree") {
        annotatedLinks = await entityLinksService.findLinkTree(
          user.organizationId,
          entityId,
          entityType,
          direction,
          maxDepth,
          linkType
        );
      } else {
        const links = await entityLinksService.findLinksByDirection(
          user.organizationId,
          entityId,
          entityType,
          direction,
          linkType
        );
        annotatedLinks = links.map((link) => ({
          link,
          fromEntityId: entityId,
        }));
      }

      const resolved = await entityLinksService.resolveLinkedEntities(
        user.organizationId,
        annotatedLinks
      );

      return successResponse(resolved);
    } catch (error) {
      return errorResponse("Failed to fetch resolved entity links", error);
    }
  }
);
