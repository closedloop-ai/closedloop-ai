import type { Artifact } from "@repo/api/src/types/artifact";
import type { ArtifactVersion } from "@repo/api/src/types/artifact-version";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { ArtifactNotFoundError } from "../../artifact-utils";
import { artifactVersionService } from "../../artifact-version-service";
import { artifactsService } from "../../service";
import { newVersionValidator } from "../../validators";

export const GET = withAnyAuth<
  Pick<
    ArtifactVersion,
    "id" | "artifactId" | "version" | "createdById" | "createdAt"
  >[],
  "/artifacts/[id]/versions"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;

    // Verify artifact exists and belongs to org
    const artifact = await artifactsService.findByIdSimple(
      id,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const versions = await artifactVersionService.listVersions(id);
    return successResponse(versions);
  } catch (error) {
    return errorResponse("Failed to fetch artifact versions", error);
  }
});

export const POST = withAnyAuth<Artifact, "/artifacts/[id]/versions">(
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

      // This delegates to artifactVersionService which atomically increments latestVersion
      const updatedArtifact = await artifactsService.createNewVersion(
        id,
        user.organizationId,
        user.id,
        body.content
      );

      return successResponse(updatedArtifact);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to create new version", error);
    }
  }
);
