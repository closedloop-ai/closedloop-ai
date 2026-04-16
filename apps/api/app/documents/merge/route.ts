import type { Document } from "@repo/api/src/types/document";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { DocumentNotFoundError } from "../document-utils";
import { documentsService } from "../service";
import { mergeDocumentsValidator } from "../validators";

const SAME_PROJECT_ERROR_RE = /same project/i;
const TEMPLATE_ERROR_RE = /TEMPLATE/i;

/**
 * POST /artifacts/merge
 * Merge two artifacts into one: combines content via LLM, saves to primary,
 * and deletes the secondary artifact.
 *
 * Why withAuth (not withAnyAuth): merge combines a write operation (new version on
 * primary) with a delete operation (secondary artifact). API key access would require
 * both write and delete scopes simultaneously, which is not supported. Restrict to
 * session-based auth only.
 */
export const POST = withAuth<Document, "/documents/merge">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        mergeDocumentsValidator
      );
      if (parseError) {
        return parseError;
      }

      const updatedArtifact = await documentsService.merge(
        body.primaryDocumentId,
        body.secondaryDocumentId,
        user.organizationId,
        user.id
      );

      return successResponse(updatedArtifact);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        return notFoundResponse("Artifact");
      }
      if (
        error instanceof Error &&
        (SAME_PROJECT_ERROR_RE.test(error.message) ||
          TEMPLATE_ERROR_RE.test(error.message))
      ) {
        return badRequestResponse(error.message);
      }
      return errorResponse("Failed to merge artifacts", error);
    }
  }
);
