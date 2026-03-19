import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  resolveEntityLinkIdentifier,
  resolveProjectId,
  resolveWorkstreamId,
} from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../../artifacts/service";
import { createArtifactValidator } from "../../../artifacts/validators";

export const GET = withAuth<Artifact[], "/workstreams/[id]/artifacts">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const workstreamId = await resolveWorkstreamId(id, user.organizationId);
      if (!workstreamId) {
        return notFoundResponse("Workstream");
      }

      const searchParams = request.nextUrl.searchParams;
      const type = (searchParams.get("type") as ArtifactType) ?? undefined;

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        workstreamId,
        type,
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
      const { id } = await params;
      const workstreamId = await resolveWorkstreamId(id, user.organizationId);
      if (!workstreamId) {
        return notFoundResponse("Workstream");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }
      let resolvedSourceId: string | undefined;
      if (body.sourceId && body.sourceType) {
        const sId = await resolveEntityLinkIdentifier(
          body.sourceId,
          user.organizationId,
          body.sourceType
        );
        if (!sId) {
          return notFoundResponse("Source entity");
        }
        resolvedSourceId = sId;
      }

      const artifact = await artifactsService.create(
        user.organizationId,
        user.id,
        {
          ...body,
          workstreamId,
          projectId: resolvedProjectId,
          sourceId: resolvedSourceId,
        }
      );
      if (!artifact) {
        return badRequestResponse("Failed to create artifact");
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  }
);
