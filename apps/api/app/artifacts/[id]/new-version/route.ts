import type { Artifact } from "@repo/api/src/types/artifact";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { ArtifactNotFoundError } from "../../artifact-utils";
import { artifactsService } from "../../service";
import { newVersionValidator } from "../../validators";

export const POST = withAuth<Artifact, "/artifacts/[id]/new-version">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        newVersionValidator
      );
      if (parseError) {
        return parseError;
      }

      const newVersion = await artifactsService.createNewVersion(
        id,
        user.organizationId,
        body.content
      );

      return successResponse(newVersion);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to create new version", error);
    }
  }
);
