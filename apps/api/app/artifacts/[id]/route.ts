import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../service";
import { updateArtifactValidator } from "../validators";

export const GET = withAuth<ArtifactWithWorkstream, "/artifacts/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const artifact = await artifactsService.findById(id, user.organizationId);

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);

export const PUT = withAuth<Artifact, "/artifacts/[id]">(
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

      const artifact = await artifactsService.update(
        id,
        user.organizationId,
        body
      );

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to update artifact", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/artifacts/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      await artifactsService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  }
);
