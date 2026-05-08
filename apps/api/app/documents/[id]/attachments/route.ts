import type {
  CreateAttachmentResponse,
  FileAttachment,
} from "@repo/api/src/types/attachment";
import { attachmentsService } from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createAttachmentValidator } from "./validators";

export const POST = withAuth<
  CreateAttachmentResponse,
  "/documents/[id]/attachments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Document");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createAttachmentValidator
    );
    if (parseError) {
      return parseError;
    }

    const { filename, mimeType, sizeBytes } = body;

    const result = await attachmentsService.requestUpload(
      resolvedId,
      user.organizationId,
      user.id,
      filename,
      mimeType,
      sizeBytes
    );

    return successResponse(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Document not found") {
      return notFoundResponse("Document");
    }
    return errorResponse("Failed to create attachment", error);
  }
});

export const GET = withAnyAuth<FileAttachment[], "/documents/[id]/attachments">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Document");
      }

      const attachments = await attachmentsService.listByDocument(
        resolvedId,
        user.organizationId
      );

      return successResponse(attachments);
    } catch (error) {
      if (error instanceof Error && error.message === "Document not found") {
        return notFoundResponse("Document");
      }
      return errorResponse("Failed to list attachments", error);
    }
  }
);
