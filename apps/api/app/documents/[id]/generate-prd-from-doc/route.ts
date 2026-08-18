import type { Document } from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import { generatePrdFromDocumentService } from "@/app/documents/generate-prd-from-doc-service";
import { captureArtifactCreation } from "@/lib/artifact-activity-capture";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { generatePrdFromDocSchema } from "./validators";

/**
 * POST /documents/[id]/generate-prd-from-doc
 *
 * Seed a DRAFT PRD from an evergreen Document (DocumentType.Doc) and link the
 * two for provenance. Returns the new PRD so the client can dispatch
 * `RunLoopCommand.GeneratePrd` against it (the existing GENERATE_PRD engine).
 */
export const POST = withAnyAuth<
  Document,
  "/documents/[id]/generate-prd-from-doc"
>(
  async ({ authMethod, user }, request, params) => {
    try {
      const { id } = await params;
      const documentId = await resolveDocumentId(id, user.organizationId);
      if (!documentId) {
        return notFoundResponse("Document");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        generatePrdFromDocSchema
      );
      if (!body) {
        return parseError;
      }

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }

      const result =
        await generatePrdFromDocumentService.generatePrdFromDocument(
          user.organizationId,
          user.id,
          {
            documentId,
            projectId: resolvedProjectId,
            title: body.title,
          }
        );

      if (!result.ok) {
        if (result.error === Status.NotFound) {
          return notFoundResponse("Document");
        }
        return badRequestResponse("Target project not found");
      }

      const prd = result.value;

      // Capture the creation into the activity feed (FEA-3864). Best-effort,
      // non-blocking — never fails this write (defense-in-depth guard).
      try {
        captureArtifactCreation({
          organizationId: user.organizationId,
          artifactId: prd.id,
          actor: { userId: user.id, authMethod },
          after: { status: prd.status, title: prd.title },
        });
      } catch {
        // Swallowed by design: activity capture must never fail the write.
      }

      return successResponse(prd);
    } catch (error) {
      return errorResponse("Failed to generate PRD from document", error);
    }
  },
  { requiredScopes: ["write"] }
);
