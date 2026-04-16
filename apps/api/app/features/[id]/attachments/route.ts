import type { FileAttachment } from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<FileAttachment[], "/features/[id]/attachments">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveFeatureId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Feature");
      }

      const attachments = await attachmentsService.listByFeature(
        resolvedId,
        user.organizationId
      );

      return successResponse(attachments);
    } catch (error) {
      if (error instanceof Error && error.message === "Feature not found") {
        return notFoundResponse("Feature");
      }
      return errorResponse("Failed to list feature attachments", error);
    }
  }
);
