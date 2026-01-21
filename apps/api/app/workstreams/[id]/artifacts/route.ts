import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../../artifacts/service";
import { createArtifactValidator } from "../../../artifacts/validators";
import { workstreamsService } from "../../service";

export const GET = withAuth<Artifact[], "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id: workstreamId } = await params;

      const workstream = await workstreamsService.findById(
        workstreamId,
        user.organizationId
      );

      if (!workstream) {
        return notFoundResponse("Workstream");
      }

      const { searchParams } = new URL(request.url);
      const type = searchParams.get("type");
      const latestOnly = searchParams.get("latestOnly") === "true";

      const artifacts = await artifactsService.findByWorkstream({
        workstreamId,
        type: type as ArtifactType | undefined,
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

      const workstream = await workstreamsService.findById(
        workstreamId,
        user.organizationId
      );

      if (!workstream) {
        return notFoundResponse("Workstream");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const artifact = await artifactsService.createForWorkstream(
        workstreamId,
        body
      );

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  }
);
