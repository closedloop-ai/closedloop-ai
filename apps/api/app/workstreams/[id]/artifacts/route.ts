import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../../artifacts/service";
import { createArtifactValidator } from "../../../artifacts/validators";

export const GET = withAuth<Artifact[], "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id: workstreamId } = await params;

      const searchParams = request.nextUrl.searchParams;
      const type = (searchParams.get("type") as ArtifactType) ?? undefined;
      const latestOnly = searchParams.get("latestOnly") === "true";

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        workstreamId,
        type,
        latestOnly,
      });

      return successResponse(artifacts);
    } catch (error) {
      return errorResponse("Failed to fetch artifacts", error);
    }
  }
);

export const POST = withAuth<Artifact, "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id: workstreamId } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      body.workstreamId = workstreamId;

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
