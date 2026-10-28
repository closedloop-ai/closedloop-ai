import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  GDriveContextImportResult,
  ImportGDriveContextResponse,
} from "@repo/api/src/types/context-attachment";
import { exportDocAsMarkdown, getDocName } from "@repo/google";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { recordContextDocumentReceipts } from "@/app/documents/context-document-receipts";
import {
  ContextDocumentErrorCode,
  contextDocumentService,
} from "@/app/documents/context-document-service";
import { documentService } from "@/app/documents/document-service";
import {
  ensureValidAccessToken,
  googleService,
  MAX_CONTENT_BYTES,
  sanitizeErrorForClient,
} from "@/app/integrations/google/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { truncateToUtf8Bytes } from "@/lib/truncate-utf8";
import { importGDriveContextValidator } from "../validators";

export const POST = withAnyAuth<
  ImportGDriveContextResponse,
  "/documents/[id]/context-attachments/gdrive"
>(
  withOperationReceipts(
    OperationKind.Create,
    async ({ user }, request, params, receipts) => {
      const { id } = await params;
      const documentId = await resolveDocumentId(id, user.organizationId);
      if (!documentId) {
        return notFoundResponse("Document");
      }

      // NOT named `parseError`: that is the `@repo/observability/error` helper the
      // catch block below logs through, and a local of the same name shadows it.
      const { body, errorResponse: bodyParseError } = await parseBody(
        request,
        importGDriveContextValidator
      );

      if (bodyParseError) {
        return bodyParseError;
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
      const successResults: GDriveContextImportResult[] = [];
      const failures: GDriveContextImportResult[] = [];

      await mapWithDbConcurrency(body.docIds, async (docId) => {
        try {
          const [docName, markdown] = await Promise.all([
            getDocName(docId, accessToken),
            exportDocAsMarkdown(docId, accessToken),
          ]);

          const truncation = truncateToUtf8Bytes(markdown, MAX_CONTENT_BYTES);
          const content = truncation.text;
          if (truncation.truncated) {
            // Message text is a Datadog query key, not prose — the first arg
            // becomes the `message` attribute monitors match on. Cap goes in
            // `maxBytes`, so the value stays sourced from the constant.
            log.warn("[gdrive-context] Truncated doc to 1MB", {
              docId,
              maxBytes: MAX_CONTENT_BYTES,
              originalBytes: truncation.originalByteLength,
              truncatedBytes: truncation.byteLength,
            });
          }

          const created = await contextDocumentService.createWithContent(
            {
              organizationId: user.organizationId,
              userId: user.id,
              sourceDocumentId: documentId,
              projectId: body.projectId,
              title: docName ?? docId,
              content,
              fileName: `${docName ?? docId}.md`,
            },
            receipts.whenRecording((tx, written) =>
              recordContextDocumentReceipts(receipts, tx, written)
            )
          );

          if (!created.ok) {
            if (created.error.code === ContextDocumentErrorCode.LinkRejected) {
              // Thrown so the log and sanitized failure below stay the single
              // path for every way this link can fail.
              throw new Error(
                `Artifact link rejected with status ${String(created.error.cause)}`
              );
            }
            failures.push({
              docId,
              error: "Failed to create artifact",
            });
            return;
          }
          successResults.push({ docId, artifactId: created.value.artifactId });
        } catch (error) {
          // Never put raw googleapis text in the response body: those messages
          // quote the offending credential bare (`ya29.…`), so `error.message`
          // would ship a live access token to the browser. Same sanitizer the
          // sibling `googleService.importDocs` path uses. The raw error still
          // goes to the log drain, same as the sibling, so an operator debugging
          // a failed import is not left with only the canned message.
          log.error("[gdrive-context] Failed to import doc", {
            organizationId: user.organizationId,
            docId,
            error: parseError(error),
          });
          failures.push({
            docId,
            error: sanitizeErrorForClient(error),
          });
        }
      });

      scheduleLogFlush();
      return successResponse({
        results: [...successResults, ...failures],
      });
    }
  )
);
