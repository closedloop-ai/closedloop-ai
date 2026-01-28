import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "./service";
import { createArtifactValidator } from "./validators";

export const GET = withAuth<ArtifactWithWorkstream[], "/artifacts">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const type = (searchParams.get("type") as ArtifactType) ?? undefined;
      const latestOnly = searchParams.get("latestOnly") !== "false";
      const workstreamId = searchParams.get("workstreamId") ?? undefined;
      const projectId = searchParams.get("projectId") ?? undefined;
      const documentSlug = searchParams.get("documentSlug") ?? undefined;

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        workstreamId,
        projectId,
        type,
        latestOnly,
        documentSlug,
      });

      return successResponse(artifacts);
    } catch (error) {
      return errorResponse("Failed to fetch artifacts", error);
    }
  }
);

export const POST = withAuth<Artifact, "/artifacts">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const artifact = await artifactsService.create(user.organizationId, body);
      if (!artifact) {
        return badRequestResponse("Failed to create artifact");
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  }
);
