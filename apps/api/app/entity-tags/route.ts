import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { EntityNotFoundError, tagService } from "../tags/service";
import { entityTagValidator } from "../tags/validators";

export const POST = withAnyAuth(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        entityTagValidator
      );
      if (parseError) {
        return parseError;
      }

      await tagService.applyTag(
        body.tagId,
        body.entityType,
        body.entityId,
        user.organizationId
      );
      return successResponse({ applied: true });
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return notFoundResponse(error.message);
      }
      return errorResponse("Failed to apply tag", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth(
  async ({ user }, request) => {
    try {
      const url = new URL(request.url);
      const tagId = url.searchParams.get("tagId");
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");

      if (!(tagId && entityType && entityId)) {
        return badRequestResponse(
          "tagId, entityType, and entityId are required"
        );
      }

      const result = entityTagValidator.safeParse({
        tagId,
        entityType,
        entityId,
      });
      if (!result.success) {
        return badRequestResponse("Invalid parameters");
      }

      await tagService.removeTag(
        result.data.tagId,
        result.data.entityType,
        result.data.entityId,
        user.organizationId
      );
      return deleteResponse();
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return notFoundResponse(error.message);
      }
      return errorResponse("Failed to remove tag", error);
    }
  },
  { requiredScopes: ["delete"] }
);
