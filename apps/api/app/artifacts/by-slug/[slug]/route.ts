import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { mergeCustomFieldsIntoResponse } from "../../../custom-fields/route-helpers";
import { artifactVersionService } from "../../artifact-version-service";
import { artifactsService } from "../../service";

export const GET = withAuth<ArtifactDetail, "/artifacts/by-slug/[slug]">(
  async ({ user }, request, params) => {
    try {
      const { slug } = await params;

      const artifact = await artifactsService.findBySlug(
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
        ? await artifactVersionService.getByVersion(artifact.id, versionNumber)
        : await artifactVersionService.getLatest(artifact.id);

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
