import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { Document, DocumentDetail } from "@repo/api/src/types/document";
import { AssignmentEntityType } from "@repo/collaboration/inbox-notifications";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
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
import { documentVersionService } from "../document-version-service";
import { documentsService } from "../service";
import { updateDocumentValidator } from "../validators";

export const GET = withAnyAuth<DocumentDetail, "/documents/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const artifact = await documentsService.findById(
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
        ? await documentVersionService.getByVersion(resolvedId, versionNumber)
        : await documentVersionService.getLatest(resolvedId);

      if (!version) {
        return notFoundResponse(
          versionParam ? `Artifact version ${versionParam}` : "Artifact version"
        );
      }

      const response = await mergeCustomFieldsIntoResponse(
        { ...artifact, version },
        CustomFieldEntityType.Document,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);

export const PUT = withAnyAuth<Document, "/documents/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateDocumentValidator
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

      const existing = await documentsService.findById(
        resolvedId,
        user.organizationId
      );
      if (!existing) {
        return notFoundResponse("Artifact");
      }

      const artifact = await documentsService.update(
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
        entityUrl: `/documents/${artifact.slug}`,
        subjectId: artifact.id,
      });

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Document,
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

export const DELETE = withAnyAuth<{ deleted: true }, "/documents/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }
      await documentsService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  },
  { requiredScopes: ["delete"] }
);
