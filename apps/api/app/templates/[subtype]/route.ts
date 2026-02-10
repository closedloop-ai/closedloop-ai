import {
  ARTIFACT_SUBTYPE_OPTIONS,
  type Artifact,
  type ArtifactSubtype,
} from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../artifacts/service";

/**
 * GET /templates/[subtype] - Get a single template by artifact subtype
 * Ensures default templates exist (lazy seeding) before returning the requested template
 */
export const GET = withAuth<Artifact, "/templates/[subtype]">(
  async ({ user }, _request, params) => {
    try {
      const { subtype } = await params;

      // Validate that subtype is a valid ArtifactSubtype
      if (!ARTIFACT_SUBTYPE_OPTIONS.includes(subtype as ArtifactSubtype)) {
        return badRequestResponse("Invalid artifact subtype");
      }

      // Lazy seeding: ensure default templates exist
      await artifactsService.ensureDefaultTemplates(user.organizationId);

      // Fetch the template for this subtype
      const template = await artifactsService.findOrgTemplate(
        user.organizationId,
        subtype as ArtifactSubtype
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
