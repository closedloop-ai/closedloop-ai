import type { Artifact, ArtifactDetail } from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

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

      const artifact = await artifactsService.findById(id, user.organizationId);

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
        ? await artifactVersionService.getByVersion(id, versionNumber)
        : await artifactVersionService.getLatest(id);

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
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...artifactInput } = body;

      const artifact = await artifactsService.update(
        id,
        user.organizationId,
        artifactInput
      );

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          id,
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
      await artifactsService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  },
  { requiredScopes: ["delete"] }
);
