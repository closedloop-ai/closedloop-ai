import type {
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createAttachmentValidator } from "./validators";

export const POST = withAuth<
  CreateAttachmentResponse,
  "/artifacts/[id]/attachments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createAttachmentValidator
    );
    if (parseError) {
      return parseError;
    }

    const { filename, mimeType, sizeBytes } = body;

    const result = await attachmentsService.requestUpload(
      id,
      user.organizationId,
      user.id,
      filename,
      mimeType,
      sizeBytes
    );

    return successResponse(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Artifact not found") {
      return notFoundResponse("Artifact");
    }
    return errorResponse("Failed to create attachment", error);
  }
});

export const GET = withAuth<FileAttachment[], "/artifacts/[id]/attachments">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const attachments = await attachmentsService.listByArtifact(
        id,
        user.organizationId
      );

      return successResponse(attachments);
    } catch (error) {
      if (error instanceof Error && error.message === "Artifact not found") {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to list attachments", error);
    }
  }
);
