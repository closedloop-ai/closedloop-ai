import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../projects/service";
import { artifactsService } from "./service";
import { createArtifactValidator } from "./validators";

export const GET = withAuth<ArtifactWithWorkstream[], "/artifacts">(
  async ({ user }, request) => {
    try {
      const { searchParams } = new URL(request.url);
      const type = searchParams.get("type");
      const latestOnly = searchParams.get("latestOnly") !== "false";
      const workstreamId = searchParams.get("workstreamId");
      const projectId = searchParams.get("projectId");
      const documentSlug = searchParams.get("documentSlug");

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        type: type as ArtifactType | undefined,
        latestOnly,
        workstreamId: workstreamId ?? undefined,
        projectId: projectId ?? undefined,
        documentSlug: documentSlug ?? undefined,
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

      // Verify project exists and belongs to user's organization if specified
      if (body.projectId) {
        const project = await projectsService.findById(
          body.projectId,
          user.organizationId
        );
        if (!project) {
          return notFoundResponse("Project");
        }
      }

      const artifact = await artifactsService.create(user.organizationId, body);

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  }
);
