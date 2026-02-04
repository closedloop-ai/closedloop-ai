import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import { withAuth } from "@/lib/auth/with-auth";
import { deleteLiveblocksRoom } from "@/lib/liveblocks";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { isDocumentArtifact } from "../artifact-utils";
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
      const artifact = await artifactsService.findByIdSimple(
        id,
        user.organizationId
      );
      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Delete the artifact from the database
      await artifactsService.delete(id, user.organizationId);

      // Asynchronously delete the Liveblocks room if it exists
      if (isDocumentArtifact(artifact) && artifact.documentSlug) {
        // Fire and forget - don't await to avoid blocking the response
        deleteLiveblocksRoom(
          generateArtifactRoomId(artifact.organizationId, artifact.documentSlug)
        );
      }

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  }
);
