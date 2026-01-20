import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { database } from "@repo/database";
import { artifactIncludeWithContext } from "@/app/artifacts/artifact-utils";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateArtifactSchema } from "../schemas";

export const GET = withAuth<ArtifactWithWorkstream, "/artifacts/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const artifact = await database.artifact.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
        include: artifactIncludeWithContext,
      });

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      return successResponse(artifact as ArtifactWithWorkstream);
    } catch (error) {
      return errorResponse("Failed to fetch artifact", error);
    }
  }
);

export const PUT = withAuth<Artifact, "/artifacts/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await database.artifact.findUnique({
        where: { id, project: { organizationId: user.organizationId } },
      });

      if (!existing) {
        return notFoundResponse("Artifact");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateArtifactSchema
      );
      if (parseError) {
        return parseError;
      }

      const artifact = await database.artifact.update({
        where: { id, project: { organizationId: user.organizationId } },
        data: body,
      });

      return successResponse(artifact as Artifact);
    } catch (error) {
      return errorResponse("Failed to update artifact", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/artifacts/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      await database.artifact.delete({
        where: { id, project: { organizationId: user.organizationId } },
      });

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete artifact", error);
    }
  }
);
