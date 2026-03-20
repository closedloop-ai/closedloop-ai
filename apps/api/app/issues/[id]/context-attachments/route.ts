import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import type { CreateContextAttachmentResponse } from "@repo/api/src/types/context-attachment";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { attachmentsService } from "@/app/artifacts/attachments-service";
import { artifactsService } from "@/app/artifacts/service";
import { entityLinksService } from "@/app/entity-links/service";
import { issuesService } from "@/app/issues/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveIssueId } from "@/lib/identifier-utils";
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
  "/issues/[id]/context-attachments"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const issueId = await resolveIssueId(id, user.organizationId);
    if (!issueId) {
      return notFoundResponse("Issue");
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createContextAttachmentValidator
    );
    if (parseError) {
      return parseError;
    }

    const issue = await issuesService.findById(issueId, user.organizationId);
    if (!issue) {
      return notFoundResponse("Issue");
    }

    const projectId = body.projectId ?? issue.projectId;
    if (!(projectId || issue.workstreamId)) {
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
        targetId: issueId,
        targetType: EntityType.Issue,
        linkType: LinkType.RelatesTo,
      });
    } catch (linkError) {
      await artifactsService.delete(artifact.id, user.organizationId);
      return errorResponse("Failed to link artifact to issue", linkError);
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
