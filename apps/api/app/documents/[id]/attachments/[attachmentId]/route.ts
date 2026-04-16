import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
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
      if (error.message === "Document not found") {
        return notFoundResponse("Document");
      }
      if (error.message === "Attachment not found") {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to get download URL", error);
  }
});

export const DELETE = withAuth<
  { deleted: true },
  "/documents/[id]/attachments/[attachmentId]"
>(async ({ user }, _, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Document");
    }

    await attachmentsService.deleteAttachment(
      resolvedId,
      user.organizationId,
      attachmentId
    );

    return deleteResponse();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Document not found") {
        return notFoundResponse("Document");
      }
      if (error.message === "Attachment not found") {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to delete attachment", error);
  }
});
