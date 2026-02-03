import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../artifacts/service";

/**
 * GET /templates/[type] - Get a single template by artifact type
 * Ensures default templates exist (lazy seeding) before returning the requested template
 */
export const GET = withAuth<Artifact, "/templates/[type]">(
  async ({ user }, _request, params) => {
    try {
      const { type } = await params;

      // Validate that type is a valid ArtifactType
      if (!Object.values(ArtifactType).includes(type as ArtifactType)) {
        return badRequestResponse("Invalid artifact type");
      }

      // Lazy seeding: ensure default templates exist
      await artifactsService.ensureDefaultTemplates(user.organizationId);

      // Fetch the template for this type
      const template = await artifactsService.findOrgTemplate(
        user.organizationId,
        type as ArtifactType
      );

      if (!template) {
        return notFoundResponse("Template");
      }

      return successResponse(template);
    } catch (error) {
      return errorResponse("Failed to fetch template", error);
    }
  }
);
