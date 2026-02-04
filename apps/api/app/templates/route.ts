import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../artifacts/service";

/**
 * GET /templates - List all org-level templates
 * Returns all artifacts where type=TEMPLATE for the authenticated user's organization.
 * Templates have type=TEMPLATE with templateForType indicating what they template for.
 */
export const GET = withAuth<Artifact[], "/templates">(
  async ({ user }, _request) => {
    try {
      const templates = await artifactsService.findAll({
        organizationId: user.organizationId,
        type: ArtifactType.Template,
        latestOnly: true,
      });

      return successResponse(templates);
    } catch (error) {
      return errorResponse("Failed to fetch templates", error);
    }
  }
);
