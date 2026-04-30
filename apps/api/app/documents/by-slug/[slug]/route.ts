import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { mergeCustomFieldsIntoResponse } from "../../../custom-fields/route-helpers";
import { documentVersionService } from "../../document-version-service";

export const GET = withAuth<DocumentDetail, "/documents/by-slug/[slug]">(
  async ({ user }, request, params) => {
    try {
      const { slug } = await params;

      const artifact = await documentService.findBySlug(
        slug,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

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
        ? await documentVersionService.getByVersion(artifact.id, versionNumber)
        : await documentVersionService.getLatest(artifact.id);

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
