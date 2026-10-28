import type { DocumentSessionsResponse } from "@repo/api/src/types/document-sessions";
import { documentSessionsService } from "@/app/documents/document-sessions-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, uuidOrSlug } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<
  DocumentSessionsResponse,
  "/documents/[id]/sessions"
>(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const identifier = uuidOrSlug().safeParse(id);
      if (!identifier.success) {
        return badRequestResponse(
          "Artifact id must be a UUID or a slug (e.g. PRD-42)."
        );
      }
      const documentId = await resolveDocumentId(
        identifier.data,
        user.organizationId
      );
      if (!documentId) {
        return notFoundResponse("Artifact");
      }
      const result = await documentSessionsService.readSessions(
        user.organizationId,
        documentId,
        request.signal
      );
      return result ? successResponse(result) : notFoundResponse("Artifact");
    } catch (error) {
      return errorResponse("Failed to fetch related sessions", error);
    }
  },
  { requiredScopes: ["read"] }
);
