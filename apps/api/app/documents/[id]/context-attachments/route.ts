import {
  AttachmentPurpose,
  isDocumentMimeType,
} from "@repo/api/src/types/attachment";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import { attachmentsService } from "@/app/documents/attachments-service";
import { recordContextDocumentReceipts } from "@/app/documents/context-document-receipts";
import { contextDocumentFailureResponse } from "@/app/documents/context-document-route-responses";
import { contextDocumentService } from "@/app/documents/context-document-service";
import { documentAttachReceiptWrite } from "@/app/documents/document-attach-receipt";
import { documentService } from "@/app/documents/document-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  type OperationReceiptRecorder,
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createContextAttachmentValidator } from "./validators";

export const POST = withAnyAuth<
  CreateContextAttachmentResponse,
  "/documents/[id]/context-attachments"
>(
  withOperationReceipts(
    OperationKind.Attach,
    async ({ user }, request, params, receipts) => {
      try {
        const { id } = await params;
        const documentId = await resolveDocumentId(id, user.organizationId);
        if (!documentId) {
          return notFoundResponse("Document");
        }

        const { body, errorResponse: parseError } = await parseBody(
          request,
          createContextAttachmentValidator
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

        if (isDocumentMimeType(body.mimeType)) {
          return await handleDocumentUpload(user, document, body, receipts);
        }

        return await handleDirectAttachment(user, documentId, body, receipts);
      } catch (error) {
        return errorResponse("Failed to create context attachment", error);
      }
    }
  )
);

async function handleDocumentUpload(
  user: { organizationId: string; id: string },
  document: {
    id: string;
    projectId: string | null;
  },
  body: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    projectId?: string;
  },
  receipts: OperationReceiptRecorder
) {
  const projectId = body.projectId ?? document.projectId;
  if (!projectId) {
    return badRequestResponse("projectId is required to create context PRD");
  }

  const result = await contextDocumentService.createWithUpload(
    {
      organizationId: user.organizationId,
      userId: user.id,
      sourceDocumentId: document.id,
      projectId,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    },
    receipts.whenRecording((tx, written) =>
      recordContextDocumentReceipts(receipts, tx, written)
    )
  );
  if (!result.ok) {
    return contextDocumentFailureResponse(result.error);
  }

  return successResponse(withOperationReceipt(result.value, receipts));
}

async function handleDirectAttachment(
  user: { organizationId: string; id: string },
  documentId: string,
  body: { filename: string; mimeType: string; sizeBytes: number },
  receipts: OperationReceiptRecorder
) {
  const uploadResult = await attachmentsService.requestUpload(
    documentId,
    user.organizationId,
    user.id,
    body.filename,
    body.mimeType,
    body.sizeBytes,
    AttachmentPurpose.Context,
    receipts.whenRecording((tx) =>
      receipts.record(tx, documentAttachReceiptWrite(documentId))
    )
  );

  return successResponse(
    withOperationReceipt(
      {
        uploadUrl: uploadResult.uploadUrl,
        artifactId: "",
        attachmentId: uploadResult.attachmentId,
      },
      receipts
    )
  );
}
