import {
  DOCUMENT_TYPE_OPTIONS,
  type Document,
  type DocumentType,
} from "@repo/api/src/types/document";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { documentTemplatesService } from "../service";
/**
 * GET /templates/[type] - Get a single template by document type
 * Ensures default templates exist (lazy seeding) before returning the requested template
 */
export const GET = withAuth<Document, "/templates/[type]">(
  async ({ user }, _request, params) => {
    try {
      const { type } = await params;

      // Validate that type is a valid DocumentType
      if (!DOCUMENT_TYPE_OPTIONS.includes(type as DocumentType)) {
        return badRequestResponse("Invalid document type");
      }

      // Lazy seeding: ensure default templates exist
      await documentTemplatesService.ensureDefaultTemplates(
        user.organizationId,
        user.id
      );

      // Fetch the template for this type
      const template = await documentTemplatesService.findOrgTemplate(
        user.organizationId,
        type as DocumentType
      );

      if (!template) {
        return notFoundResponse("Template");
      }

      return successResponse(template);
    } catch (error) {
      return errorResponse("Failed to fetch template", error);
    }
  }
);
