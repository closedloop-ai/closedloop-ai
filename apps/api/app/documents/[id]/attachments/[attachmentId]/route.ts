import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import {
  ATTACHMENT_NOT_FOUND_ERROR,
  attachmentsService,
  type DeleteAttachmentError,
  DeleteAttachmentErrorCode,
  DOCUMENT_NOT_FOUND_ERROR,
} from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<
  AttachmentDownloadResponse,
  "/documents/[id]/attachments/[attachmentId]"
>(async ({ user }, _request, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Document");
    }

    const result = await attachmentsService.getDownloadUrl(
      resolvedId,
      user.organizationId,
      attachmentId
    );

    return successResponse(result);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === DOCUMENT_NOT_FOUND_ERROR) {
        return notFoundResponse("Document");
      }
      if (error.message === ATTACHMENT_NOT_FOUND_ERROR) {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to get download URL", error);
  }
});

export const DELETE = withAnyAuth<
  { deleted: true },
  "/documents/[id]/attachments/[attachmentId]"
>(async ({ authMethod, user }, _, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Document");
    }

    const result = await attachmentsService.deleteAttachment(
      resolvedId,
      user.organizationId,
      user.id,
      attachmentId,
      { requireCreatorOwnership: authMethod === "api_key" }
    );

    if (result.ok === false) {
      return mapDeleteAttachmentFailure(result.error);
    }

    return deleteResponse();
  } catch (error) {
    return errorResponse("Failed to delete attachment", error);
  }
});

function mapDeleteAttachmentFailure(error: DeleteAttachmentError) {
  if (error.code === DeleteAttachmentErrorCode.DocumentNotFound) {
    return notFoundResponse("Document");
  }
  if (
    error.code === DeleteAttachmentErrorCode.AttachmentNotFound ||
    error.code === DeleteAttachmentErrorCode.NotOwned
  ) {
    return notFoundResponse("Attachment");
  }
  return notFoundResponse(getUnhandledDeleteAttachmentFallback(error.code));
}

function getUnhandledDeleteAttachmentFallback(_errorCode: never): "Attachment" {
  return "Attachment";
}
