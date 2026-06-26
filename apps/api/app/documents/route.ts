import type {
  Document,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
} from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  createDocumentValidator,
  findDocumentsQueryValidator,
} from "./validators";

/**
 * GET /documents - List documents
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<DocumentWithProject[], "/documents">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = findDocumentsQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { projectId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }

      const documents = await documentService.findAllWithCustomFields({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        ...restQuery,
      });

      return successResponse(documents);
    } catch (error) {
      return errorResponse("Failed to fetch documents", error);
    }
  }
);

export const POST = withAnyAuth<Document, "/documents">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createDocumentValidator
      );
      if (parseError) {
        return parseError;
      }

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }
      let resolvedSourceId: string | undefined;
      if (body.sourceId) {
        const sId = await resolveArtifactIdentifier(
          body.sourceId,
          user.organizationId
        );
        if (!sId) {
          return notFoundResponse("Source artifact");
        }
        resolvedSourceId = sId;
      }

      const document = await documentService.create(
        user.organizationId,
        user.id,
        {
          ...body,
          projectId: resolvedProjectId,
          sourceId: resolvedSourceId,
        }
      );
      if (!document) {
        return badRequestResponse("Failed to create document");
      }

      return successResponse(document);
    } catch (error) {
      return errorResponse("Failed to create document", error);
    }
  },
  { requiredScopes: ["write"] }
);
