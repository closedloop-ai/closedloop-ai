import { isDocumentMimeType } from "@repo/api/src/types/attachment";
import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { attachmentsService } from "@/app/documents/attachments-service";
import { documentsService } from "@/app/documents/service";
import { entityLinksService } from "@/app/entity-links/service";
import { featuresService } from "@/app/features/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId } from "@/lib/identifier-utils";
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
  "/features/[id]/context-attachments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const featureId = await resolveFeatureId(id, user.organizationId);
    if (!featureId) {
      return notFoundResponse("Feature");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createContextAttachmentValidator
    );
    if (parseError) {
      return parseError;
    }

    const feature = await featuresService.findById(
      featureId,
      user.organizationId
    );
    if (!feature) {
      return notFoundResponse("Feature");
    }

    // Document types (md, pdf, doc, docx, html) → create a PRD artifact + entity link
    // Non-document types (images, video, spreadsheets) → attach directly to the feature
    if (isDocumentMimeType(body.mimeType)) {
      return handleDocumentUpload(user, feature, featureId, body);
    }
    return handleDirectAttachment(user, featureId, body);
  } catch (error) {
    return errorResponse("Failed to create context attachment", error);
  }
});

async function handleDocumentUpload(
  user: { organizationId: string; id: string },
  feature: { projectId: string; workstreamId: string | null },
  featureId: string,
  body: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    projectId?: string;
  }
) {
  const projectId = body.projectId ?? feature.projectId;
  if (!(projectId || feature.workstreamId)) {
    return badRequestResponse(
      "Either projectId or workstreamId is required to attach context"
    );
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
    await entityLinksService.createLink(user.organizationId, {
      sourceId: artifact.id,
      sourceType: EntityType.Document,
      targetId: featureId,
      targetType: EntityType.Feature,
      linkType: LinkType.RelatesTo,
    });
  } catch (linkError) {
    await documentsService.delete(artifact.id, user.organizationId);
    return errorResponse("Failed to link artifact to feature", linkError);
  }

  return successResponse({
    uploadUrl: uploadResult.uploadUrl,
    artifactId: artifact.id,
    attachmentId: uploadResult.attachmentId,
  });
}

async function handleDirectAttachment(
  user: { organizationId: string; id: string },
  featureId: string,
  body: { filename: string; mimeType: string; sizeBytes: number }
) {
  const uploadResult = await attachmentsService.requestFeatureUpload(
    featureId,
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
