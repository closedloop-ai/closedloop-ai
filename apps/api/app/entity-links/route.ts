import type { EntityLink } from "@repo/api/src/types/entity-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
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
      const searchParams = request.nextUrl.searchParams;
      const queryParams = Object.fromEntries(searchParams.entries());

      const parseResult = findEntityLinksQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { entityId, entityType, linkType, direction } = parseResult.data;

      let links: EntityLink[];
      switch (direction) {
        case "source":
          links = await entityLinksService.findSourceLinks(
            user.organizationId,
            entityId,
            entityType,
            linkType
          );
          break;
        case "target":
          links = await entityLinksService.findTargetLinks(
            user.organizationId,
            entityId,
            entityType,
            linkType
          );
          break;
        default:
          links = await entityLinksService.findLinks(
            user.organizationId,
            entityId,
            entityType,
            linkType
          );
          break;
      }

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
      return errorResponse("Failed to create entity link", error);
    }
  },
  { requiredScopes: ["write"] }
);
