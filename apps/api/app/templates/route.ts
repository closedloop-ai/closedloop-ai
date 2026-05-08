import type { Document } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
/**
 * GET /templates - List all org-level templates
 * Returns all artifacts where type=TEMPLATE for the authenticated user's organization.
 */
export const GET = withAnyAuth<Document[], "/templates">(
  async ({ user }, _request) => {
    try {
      const templates = await documentService.findAll({
        organizationId: user.organizationId,
        type: DocumentType.Template,
      });

      return successResponse(templates);
    } catch (error) {
      return errorResponse("Failed to fetch templates", error);
    }
  }
);
