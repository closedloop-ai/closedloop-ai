import type { AttachmentDownloadResponse } from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<
  AttachmentDownloadResponse,
  "/artifacts/[id]/attachments/[attachmentId]"
>(async ({ user }, _request, params) => {
  try {
    const { id, attachmentId } = await params;
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const result = await attachmentsService.getDownloadUrl(
      resolvedId,
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
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    await attachmentsService.deleteAttachment(
      resolvedId,
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
