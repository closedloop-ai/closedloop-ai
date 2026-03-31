import type { BatchMoveEntitiesResult } from "@repo/api/src/types/entity-link";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { entityLinksService } from "../service";
import { batchMoveEntitiesValidator } from "../validators";

/**
 * POST /entity-links/batch-move
 * Move an entity and optionally all its downstream entities to a target project.
 */
export const POST = withAnyAuth<
  BatchMoveEntitiesResult,
  "/entity-links/batch-move"
>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchMoveEntitiesValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await entityLinksService.batchMoveEntities(
        user.organizationId,
        body
      );

      if (result.ok) {
        return successResponse(result.value);
      }

      return badRequestResponse("Failed to move items");
    } catch (error) {
      return errorResponse("Failed to move entities", error);
    }
  },
  { requiredScopes: ["write"] }
);
