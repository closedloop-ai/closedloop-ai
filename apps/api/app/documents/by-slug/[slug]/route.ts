import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import {
  documentStatusMutationPermissionsForAuth,
  withDocumentStatusMutation,
} from "@/app/documents/document-status-mutation-capability";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { mergeCustomFieldsIntoResponse } from "../../../custom-fields/route-helpers";
import { documentVersionService } from "../../document-version-service";
import {
  parseVersionParam,
  resolveLatestVersionContent,
} from "../../version-route-helpers";

export const GET = withAnyAuth<DocumentDetail, "/documents/by-slug/[slug]">(
  async (auth, request, params) => {
    const { user } = auth;
    try {
      const { slug } = await params;

      const artifact = await documentService.findBySlug(
        slug,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      const parsedVersion = parseVersionParam(request);
      if (parsedVersion.ok === false) {
        return parsedVersion.response;
      }
      const { versionParam, versionNumber } = parsedVersion;

      const version = versionNumber
        ? await documentVersionService.getByVersion(artifact.id, versionNumber)
        : await documentVersionService.getLatest(artifact.id);

      if (!version) {
        return notFoundResponse(
          versionParam ? `Artifact version ${versionParam}` : "Artifact version"
        );
      }

      const latestVersionContent = await resolveLatestVersionContent(
        artifact,
        version
      );

      if (!latestVersionContent) {
        return notFoundResponse("Artifact latest version");
      }

      const response = await mergeCustomFieldsIntoResponse(
        withDocumentStatusMutation(
          {
            ...artifact,
            ...latestVersionContent,
            version,
          },
          documentStatusMutationPermissionsForAuth(auth)
        ),
        CustomFieldEntityType.Document,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);
