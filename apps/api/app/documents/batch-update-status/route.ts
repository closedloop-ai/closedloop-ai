import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { documentService } from "../document-service";
import { batchUpdateStatusValidator } from "../validators";

/**
 * POST /documents/batch-update-status
 * Update the status of multiple documents atomically.
 */
export const POST = withAnyAuth(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchUpdateStatusValidator
      );
      if (parseError) {
        return parseError;
      }

      const updatedIds = await documentService.batchUpdateStatus(
        body.documentIds,
        body.status,
        user.organizationId
      );

      return successResponse(updatedIds);
    } catch (error) {
      return errorResponse("Failed to update document statuses", error);
    }
  },
  { requiredScopes: ["write"] }
);
