import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type {
  Document,
  DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  resolveArtifactIdentifier,
  resolveProjectId,
  resolveWorkstreamId,
} from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import {
  createDocumentValidator,
  findDocumentsQueryValidator,
} from "./validators";

/**
 * GET /documents - List documents
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<DocumentWithWorkstream[], "/documents">(
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

      const { projectId, workstreamId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }
      let resolvedWorkstreamId: string | undefined;
      if (workstreamId) {
        const wId = await resolveWorkstreamId(
          workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const documents = await documentService.findAll({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
        ...restQuery,
      });

      // Batch-load custom field values for all documents in a single query
      const documentIds = documents.map((a) => a.id);
      const allValues =
        documentIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Document,
              documentIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        documents.map((a) => [a.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const documentsWithFields = documents.map((a) => ({
        ...a,
        customFields: valuesByEntityId.get(a.id) ?? [],
      }));

      return successResponse(documentsWithFields);
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
      let resolvedWorkstreamId: string | undefined;
      if (body.workstreamId) {
        const wId = await resolveWorkstreamId(
          body.workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
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
          workstreamId: resolvedWorkstreamId,
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
