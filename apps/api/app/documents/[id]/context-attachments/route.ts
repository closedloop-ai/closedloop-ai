import { LinkType } from "@repo/api/src/types/artifact";
import { isDocumentMimeType } from "@repo/api/src/types/attachment";
import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { artifactLinksService } from "@/app/artifact-links/service";
import { attachmentsService } from "@/app/documents/attachments-service";
import { documentsService } from "@/app/documents/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createContextAttachmentValidator } from "./validators";

export const POST = withAnyAuth<
  CreateContextAttachmentResponse,
  "/documents/[id]/context-attachments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const documentId = await resolveDocumentId(id, user.organizationId);
    if (!documentId) {
      return notFoundResponse("Document");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createContextAttachmentValidator
    );
    if (parseError) {
      return parseError;
    }

    const document = await documentsService.findById(
      documentId,
      user.organizationId
    );
    if (!document) {
      return notFoundResponse("Document");
    }

    if (isDocumentMimeType(body.mimeType)) {
      return await handleDocumentUpload(user, document, body);
    }

    return await handleDirectAttachment(user, documentId, body);
  } catch (error) {
    return errorResponse("Failed to create context attachment", error);
  }
});

async function handleDocumentUpload(
  user: { organizationId: string; id: string },
  document: {
    id: string;
    projectId: string | null;
    workstreamId: string | null;
  },
  body: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    projectId?: string;
  }
) {
  const projectId = body.projectId ?? document.projectId;
  if (!(projectId || document.workstreamId)) {
    return badRequestResponse(
      "Either projectId or workstreamId is required to attach context"
    );
  }
  if (!projectId) {
    return badRequestResponse("projectId is required to create context PRD");
  }

  const artifact = await documentsService.create(user.organizationId, user.id, {
    title: body.filename,
    type: DocumentType.Prd,
    status: DocumentStatus.Draft,
    projectId,
    content: "",
  });

  if (!artifact) {
    return errorResponse(
      "Failed to create artifact for context attachment",
      null
    );
  }

  let uploadResult: Awaited<
    ReturnType<typeof attachmentsService.requestUpload>
  >;
  try {
    uploadResult = await attachmentsService.requestUpload(
      artifact.id,
      user.organizationId,
      user.id,
      body.filename,
      body.mimeType,
      body.sizeBytes
    );
  } catch (uploadError) {
    await documentsService.delete(artifact.id, user.organizationId);
    return errorResponse("Failed to request upload", uploadError);
  }

  try {
    await artifactLinksService.createLink(user.organizationId, {
      sourceId: artifact.id,
      targetId: document.id,
      linkType: LinkType.Produces,
    });
  } catch (linkError) {
    await documentsService.delete(artifact.id, user.organizationId);
    return errorResponse("Failed to link artifact to document", linkError);
  }

  return successResponse({
    uploadUrl: uploadResult.uploadUrl,
    artifactId: artifact.id,
    attachmentId: uploadResult.attachmentId,
  });
}

async function handleDirectAttachment(
  user: { organizationId: string; id: string },
  documentId: string,
  body: { filename: string; mimeType: string; sizeBytes: number }
) {
  const uploadResult = await attachmentsService.requestUpload(
    documentId,
    user.organizationId,
    user.id,
    body.filename,
    body.mimeType,
    body.sizeBytes
  );

  return successResponse({
    uploadUrl: uploadResult.uploadUrl,
    artifactId: "",
    attachmentId: uploadResult.attachmentId,
  });
}
