import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAuth<
  AttachmentDownloadResponse,
  "/artifacts/[id]/attachments/[attachmentId]"
>(async ({ user }, _request, params) => {
  try {
    const { id, attachmentId } = await params;

    const result = await attachmentsService.getDownloadUrl(
      id,
      user.organizationId,
      attachmentId
    );

    return successResponse(result);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Artifact not found") {
        return notFoundResponse("Artifact");
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
  "/artifacts/[id]/attachments/[attachmentId]"
>(async ({ user }, _, params) => {
  try {
    const { id, attachmentId } = await params;

    await attachmentsService.deleteAttachment(
      id,
      user.organizationId,
      attachmentId
    );

    return deleteResponse();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Artifact not found") {
        return notFoundResponse("Artifact");
      }
      if (error.message === "Attachment not found") {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to delete attachment", error);
  }
});
