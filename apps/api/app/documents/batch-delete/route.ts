import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { documentService } from "../document-service";
import { batchDeleteValidator } from "../validators";

/**
 * POST /documents/batch-delete
 * Delete multiple documents and clean up their Liveblocks rooms.
 */
export const POST = withAnyAuth(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchDeleteValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await documentService.batchDelete(
        body.documentIds,
        user.organizationId
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to delete documents", error);
    }
  },
  { requiredScopes: ["delete"] }
);
