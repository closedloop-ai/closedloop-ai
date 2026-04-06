import {
  EntityType,
  type LinkedEntity,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import {
  type ExternalLink,
  ExternalLinkType,
} from "@repo/api/src/types/external-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { schedulePrReadRepair } from "@/lib/pr-read-repair";
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

      if (mode === LinkQueryMode.Tree) {
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

      const prLinks = resolved.flatMap((le) =>
        le.resolvedEntity?.type === EntityType.ExternalLink &&
        le.resolvedEntity.entity.type === ExternalLinkType.PullRequest
          ? [le.resolvedEntity.entity as ExternalLink]
          : []
      );
      schedulePrReadRepair(prLinks, user.organizationId);

      return successResponse(resolved);
    } catch (error) {
      return errorResponse("Failed to fetch resolved entity links", error);
    }
  }
);
