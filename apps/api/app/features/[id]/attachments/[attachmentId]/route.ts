import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<
  AttachmentDownloadResponse,
  "/features/[id]/attachments/[attachmentId]"
>(async ({ user }, _request, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveFeatureId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Feature");
    }

    const result = await attachmentsService.getFeatureDownloadUrl(
      resolvedId,
      user.organizationId,
      attachmentId
    );

    return successResponse(result);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Feature not found") {
        return notFoundResponse("Feature");
      }
      if (error.message === "Attachment not found") {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to get download URL", error);
  }
});

export const DELETE = withAnyAuth<
  { deleted: true },
  "/features/[id]/attachments/[attachmentId]"
>(async ({ user }, _, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveFeatureId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Feature");
    }

    await attachmentsService.deleteFeatureAttachment(
      resolvedId,
      user.organizationId,
      attachmentId
    );

    return deleteResponse();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "Feature not found") {
        return notFoundResponse("Feature");
      }
      if (error.message === "Attachment not found") {
        return notFoundResponse("Attachment");
      }
    }
    return errorResponse("Failed to delete attachment", error);
  }
});
