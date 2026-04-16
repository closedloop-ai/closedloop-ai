import type { Document, DocumentType } from "@repo/api/src/types/document";
import { withAuth } from "@/lib/auth/with-auth";
import {
  resolveEntityLinkIdentifier,
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
import { documentsService } from "../../../documents/service";
import { createDocumentValidator } from "../../../documents/validators";

export const GET = withAuth<Document[], "/workstreams/[id]/documents">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const workstreamId = await resolveWorkstreamId(id, user.organizationId);
      if (!workstreamId) {
        return notFoundResponse("Workstream");
      }

      const searchParams = request.nextUrl.searchParams;
      const type = (searchParams.get("type") as DocumentType) ?? undefined;

      const documents = await documentsService.findAll({
        organizationId: user.organizationId,
        workstreamId,
        type,
      });

      return successResponse(documents);
    } catch (error) {
      return errorResponse("Failed to fetch documents", error);
    }
  }
);

export const POST = withAuth<Document, "/workstreams/[id]/documents">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const workstreamId = await resolveWorkstreamId(id, user.organizationId);
      if (!workstreamId) {
        return notFoundResponse("Workstream");
      }

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
      if (body.sourceId && body.sourceType) {
        const sId = await resolveEntityLinkIdentifier(
          body.sourceId,
          user.organizationId,
          body.sourceType
        );
        if (!sId) {
          return notFoundResponse("Source entity");
        }
        resolvedSourceId = sId;
      }

      const document = await documentsService.create(
        user.organizationId,
        user.id,
        {
          ...body,
          workstreamId,
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
  }
);
