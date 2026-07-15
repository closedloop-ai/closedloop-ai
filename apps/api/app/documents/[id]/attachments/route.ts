import {
  AttachmentPurpose,
  type CreateAttachmentResponse,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import { failure } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { isMcpAttachmentUploadEnabled } from "@/app/documents/attachment-upload-feature";
import {
  type AttachmentUploadError,
  attachmentsService,
  DOCUMENT_NOT_FOUND_ERROR,
  INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR,
} from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import {
  createAttachmentValidator,
  listAttachmentsQueryValidator,
} from "./validators";

type CreateAttachmentDiagnostics = {
  mimeType?: string;
  purpose?: string;
  sizeBytes?: number;
};

function getCreateAttachmentDiagnostics(
  value: unknown
): CreateAttachmentDiagnostics {
  if (!isRecord(value)) {
    return {};
  }

  return {
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    purpose: typeof value.purpose === "string" ? value.purpose : undefined,
    sizeBytes:
      typeof value.sizeBytes === "number" ? value.sizeBytes : undefined,
  };
}

async function readCreateAttachmentDiagnostics(
  request: Request
): Promise<CreateAttachmentDiagnostics> {
  try {
    return getCreateAttachmentDiagnostics(await request.clone().json());
  } catch {
    return {};
  }
}

function isInlineAttachmentAttempt(
  diagnostics: CreateAttachmentDiagnostics
): boolean {
  return diagnostics.purpose === AttachmentPurpose.Inline;
}

export const POST = withAnyAuth<
  CreateAttachmentResponse,
  "/documents/[id]/attachments"
>(async ({ authMethod, clerkUserId, user }, request, params) => {
  try {
    const { id } = await params;
    const diagnostics = await readCreateAttachmentDiagnostics(request);
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      if (isInlineAttachmentAttempt(diagnostics)) {
        log.warn(
          "[documents/attachments] Inline attachment upload document not found",
          {
            documentId: id,
            ...diagnostics,
            reason: "document_not_found",
          }
        );
      }
      return notFoundResponse("Document");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createAttachmentValidator
    );
    if (parseError) {
      if (isInlineAttachmentAttempt(diagnostics)) {
        log.warn(
          "[documents/attachments] Inline attachment upload validation rejected",
          {
            documentId: resolvedId,
            ...diagnostics,
            reason: "validation_rejected",
          }
        );
      }
      return parseError;
    }

    const { filename, mimeType, purpose, sizeBytes } = body;

    if (
      authMethod === "api_key" &&
      !(await isMcpAttachmentUploadEnabled({
        clerkUserId,
        userId: user.id,
      }))
    ) {
      return forbiddenAttachmentUploadResponse();
    }

    const result = await attachmentsService.requestDirectUpload(
      resolvedId,
      user.organizationId,
      user.id,
      filename,
      mimeType,
      sizeBytes,
      purpose
    );
    if (result.ok === false) {
      return mapAttachmentUploadFailure(result.error);
    }

    return successResponse(result.value);
  } catch (error) {
    if (error instanceof Error && error.message === DOCUMENT_NOT_FOUND_ERROR) {
      return notFoundResponse("Document");
    }
    if (
      error instanceof Error &&
      error.message === INVALID_INLINE_ATTACHMENT_UPLOAD_ERROR
    ) {
      return badRequestResponse(error.message);
    }
    return errorResponse("Failed to create attachment", error);
  }
});

export const GET = withAnyAuth<FileAttachment[], "/documents/[id]/attachments">(
  async ({ user }, request, params) => {
    try {
      const { params: query, errorResponse: queryError } = parseQueryParams(
        request,
        listAttachmentsQueryValidator
      );
      if (queryError) {
        return queryError;
      }

      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Document");
      }

      const attachments = await attachmentsService.listByDocument(
        resolvedId,
        user.organizationId,
        query.purpose
      );

      return successResponse(attachments);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === DOCUMENT_NOT_FOUND_ERROR
      ) {
        return notFoundResponse("Document");
      }
      return errorResponse("Failed to list attachments", error);
    }
  }
);

function forbiddenAttachmentUploadResponse() {
  return NextResponse.json(
    failure("MCP attachment upload is disabled", {
      code: "mcp_attachment_upload_disabled",
    }),
    { status: 403 }
  );
}

function attachmentUploadRateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    failure("Attachment upload rate limit exceeded", {
      code: "attachment_upload_rate_limited",
      details: { retryAfterSeconds },
    }),
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

function mapAttachmentUploadFailure(error: AttachmentUploadError) {
  return attachmentUploadRateLimitResponse(error.retryAfterSeconds);
}
