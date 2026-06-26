import { LinkType } from "@repo/api/src/types/artifact";
import type {
  GDriveContextImportResult,
  ImportGDriveContextResponse,
} from "@repo/api/src/types/context-attachment";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { exportDocAsMarkdown, getDocName } from "@repo/google";
import { log } from "@repo/observability/log";
import pLimit from "p-limit";
import { artifactLinksService } from "@/app/artifact-links/service";
import { documentService } from "@/app/documents/document-service";
import {
  ensureValidAccessToken,
  googleService,
} from "@/app/integrations/google/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { importGDriveContextValidator } from "../validators";

export const POST = withAnyAuth<
  ImportGDriveContextResponse,
  "/documents/[id]/context-attachments/gdrive"
>(async ({ user }, request, params) => {
  const { id } = await params;
  const documentId = await resolveDocumentId(id, user.organizationId);
  if (!documentId) {
    return notFoundResponse("Document");
  }

  const { body, errorResponse: parseError } = await parseBody(
    request,
    importGDriveContextValidator
  );

  if (parseError) {
    return parseError;
  }

  const document = await documentService.findById(
    documentId,
    user.organizationId
  );
  if (!document) {
    return notFoundResponse("Document");
  }

  const googleIntegration = await googleService.getIntegration(
    user.organizationId
  );

  if (!googleIntegration) {
    return errorResponse(
      "Google Drive is not connected. Please connect in settings.",
      null,
      400
    );
  }

  const tokenResult = await ensureValidAccessToken(
    googleIntegration,
    user.organizationId,
    "[google/gdrive-context]"
  );

  if (!tokenResult.success) {
    return errorResponse(tokenResult.error, null, 401);
  }

  const { accessToken } = tokenResult;
  const limit = pLimit(5);
  const successResults: GDriveContextImportResult[] = [];
  const failures: GDriveContextImportResult[] = [];

  const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB

  const importPromises = body.docIds.map((docId) =>
    limit(async () => {
      try {
        const [docName, markdown] = await Promise.all([
          getDocName(docId, accessToken),
          exportDocAsMarkdown(docId, accessToken),
        ]);

        let content = markdown;
        if (content.length > MAX_CONTENT_SIZE) {
          content = content.slice(0, MAX_CONTENT_SIZE);
          log.warn("[gdrive-context] Truncated doc to 1MB", {
            docId,
            originalSize: markdown.length,
            truncatedSize: content.length,
          });
        }

        const artifact = await documentService.create(
          user.organizationId,
          user.id,
          {
            type: DocumentType.Prd,
            status: DocumentStatus.Draft,
            projectId: body.projectId,
            title: docName ?? docId,
            content,
            fileName: `${docName ?? docId}.md`,
          }
        );

        if (!artifact) {
          failures.push({
            docId,
            error: "Failed to create artifact",
          });
          return;
        }

        try {
          await artifactLinksService.createLink(user.organizationId, {
            sourceId: artifact.id,
            targetId: documentId,
            linkType: LinkType.Produces,
          });
        } catch (linkError) {
          await documentService.delete(artifact.id, user.organizationId);
          throw linkError;
        }

        successResults.push({ docId, artifactId: artifact.id });
      } catch (error) {
        failures.push({
          docId,
          error:
            error instanceof Error
              ? error.message
              : "Failed to import document",
        });
      }
    })
  );

  await Promise.all(importPromises);

  scheduleLogFlush();
  return successResponse({
    results: [...successResults, ...failures],
  });
});
