import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { EntityNotFoundError, tagService } from "../../tags/service";
import { batchEntityTagValidator } from "../../tags/validators";

/**
 * POST /entity-tags/batch
 * Apply a tag to multiple entities at once (idempotent).
 */
export const POST = withAnyAuth(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchEntityTagValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await tagService.batchApplyTag(
        body.tagId,
        body.entityType,
        body.entityIds,
        user.organizationId
      );

      return successResponse(result);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return notFoundResponse(error.message);
      }
      return errorResponse("Failed to apply tags", error);
    }
  },
  { requiredScopes: ["write"] }
);
