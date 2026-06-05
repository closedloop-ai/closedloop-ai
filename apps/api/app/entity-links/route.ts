import {
  type EntityLink,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { EntityOrganizationMismatchError } from "@/lib/entity-validation";
import { resolveEntityLinkIdentifier } from "@/lib/identifier-utils";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { entityLinksService } from "./service";
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

      const resolvedEntityId = await resolveEntityLinkIdentifier(
        entityId,
        user.organizationId,
        entityType
      );
      if (!resolvedEntityId) {
        return notFoundResponse("Entity");
      }

      if (mode === LinkQueryMode.Tree) {
        const annotatedLinks = await entityLinksService.findLinkTree(
          user.organizationId,
          resolvedEntityId,
          entityType,
          direction,
          maxDepth,
          linkType
        );
        return successResponse(annotatedLinks.map((a) => a.link));
      }

      const links = await entityLinksService.findLinksByDirection(
        user.organizationId,
        resolvedEntityId,
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

      const resolvedSourceId = await resolveEntityLinkIdentifier(
        body.sourceId,
        user.organizationId,
        body.sourceType
      );
      if (!resolvedSourceId) {
        return notFoundResponse("Source entity");
      }
      const resolvedTargetId = await resolveEntityLinkIdentifier(
        body.targetId,
        user.organizationId,
        body.targetType
      );
      if (!resolvedTargetId) {
        return notFoundResponse("Target entity");
      }

      const link = await entityLinksService.createLink(user.organizationId, {
        ...body,
        sourceId: resolvedSourceId,
        targetId: resolvedTargetId,
      });

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
