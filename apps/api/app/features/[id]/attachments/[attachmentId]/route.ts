import { attachmentsService } from "@/app/artifacts/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";

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

    await attachmentsService.deleteFeatureAttachment(resolvedId, attachmentId);

    return deleteResponse();
  } catch (error) {
    if (error instanceof Error && error.message === "Attachment not found") {
      return notFoundResponse("Attachment");
    }
    return errorResponse("Failed to delete attachment", error);
  }
});
