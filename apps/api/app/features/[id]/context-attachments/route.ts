import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { artifactsService } from "@/app/artifacts/service";
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

    const projectId = body.projectId ?? feature.projectId;
    if (!(projectId || feature.workstreamId)) {
      return badRequestResponse(
        "Either projectId or workstreamId is required to attach context"
      );
    }

    const artifact = await artifactsService.create(
      user.organizationId,
      user.id,
      {
        title: body.filename,
        type: ArtifactType.Prd,
        status: ArtifactStatus.Draft,
        projectId,
        content: "",
      }
    );

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
      await artifactsService.delete(artifact.id, user.organizationId);
      return errorResponse("Failed to request upload", uploadError);
    }

    try {
      await entityLinksService.createLink(user.organizationId, {
        sourceId: artifact.id,
        sourceType: EntityType.Artifact,
        targetId: featureId,
        targetType: EntityType.Feature,
        linkType: LinkType.RelatesTo,
      });
    } catch (linkError) {
      await artifactsService.delete(artifact.id, user.organizationId);
      return errorResponse("Failed to link artifact to feature", linkError);
    }

    return successResponse({
      uploadUrl: uploadResult.uploadUrl,
      artifactId: artifact.id,
      attachmentId: uploadResult.attachmentId,
    });
  } catch (error) {
    return errorResponse("Failed to create context attachment", error);
  }
});
