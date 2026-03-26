import type { Artifact, ArtifactDetail } from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { AssignmentEntityType } from "@repo/collaboration/inbox-notifications";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId, resolveProjectId } from "@/lib/identifier-utils";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  applyCustomFieldsFromBody,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { artifactVersionService } from "../artifact-version-service";
import { artifactsService } from "../service";
import { updateArtifactValidator } from "../validators";

export const GET = withAnyAuth<ArtifactDetail, "/artifacts/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveArtifactId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const artifact = await artifactsService.findById(
        resolvedId,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Fetch a specific version's content, or latest by default
      const versionParam = request.nextUrl.searchParams.get("version");
      const versionNumber = versionParam ? Number(versionParam) : undefined;

      if (
        versionNumber !== undefined &&
        (Number.isNaN(versionNumber) ||
          versionNumber < 1 ||
          !Number.isInteger(versionNumber))
      ) {
        return errorResponse(
          "Invalid version parameter",
          new Error("Version must be a positive integer")
        );
      }

      const version = versionNumber
        ? await artifactVersionService.getByVersion(resolvedId, versionNumber)
        : await artifactVersionService.getLatest(resolvedId);

      if (!version) {
        return notFoundResponse(
          versionParam ? `Artifact version ${versionParam}` : "Artifact version"
        );
      }

      const response = await mergeCustomFieldsIntoResponse(
        { ...artifact, version },
        CustomFieldEntityType.Artifact,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);

export const PUT = withAnyAuth<Artifact, "/artifacts/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveArtifactId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...artifactInput } = body;

      if (artifactInput.projectId) {
        const pId = await resolveProjectId(
          artifactInput.projectId,
          user.organizationId
        );
        if (!pId) {
          return notFoundResponse("Project");
        }
        artifactInput.projectId = pId;
      }

      const existing = await artifactsService.findById(
        resolvedId,
        user.organizationId
      );
      if (!existing) {
        return notFoundResponse("Artifact");
      }

      const artifact = await artifactsService.update(
        resolvedId,
        user.organizationId,
        artifactInput
      );

      dispatchAssignmentNotification({
        previousAssigneeId: existing.assigneeId,
        newAssigneeId: artifactInput.assigneeId,
        actorUserId: user.id,
        organizationId: user.organizationId,
        entityType: AssignmentEntityType.Artifact,
        entityTitle: artifact.title,
        entityUrl: `/artifacts/${artifact.slug}`,
        subjectId: artifact.id,
      });

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Artifact,
          user.organizationId
        );
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to update artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/artifacts/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveArtifactId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }
      await artifactsService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  },
  { requiredScopes: ["delete"] }
);
