import type { Artifact } from "@repo/api/src/types/artifact";
import type { ArtifactVersion } from "@repo/api/src/types/artifact-version";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { ArtifactNotFoundError } from "../../artifact-utils";
import { artifactVersionService } from "../../artifact-version-service";
import { resetArtifactRoom } from "../../room-utils";
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
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    // Verify artifact exists and belongs to org
    const artifact = await artifactsService.findByIdSimple(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const versions = await artifactVersionService.listVersions(resolvedId);
    return successResponse(versions);
  } catch (error) {
    return errorResponse("Failed to fetch artifact versions", error);
  }
});

export const POST = withAnyAuth<Artifact, "/artifacts/[id]/versions">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveArtifactId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        newVersionValidator
      );
      if (parseError) {
        return parseError;
      }

      // This delegates to artifactVersionService which atomically increments latestVersion
      const updatedArtifact = await artifactsService.createNewVersion(
        resolvedId,
        user.organizationId,
        user.id,
        body.content
      );

      // Reset the Liveblocks room so the collaborative editor picks up the
      // new version content instead of serving the stale Y.Doc.
      await resetArtifactRoom(updatedArtifact).catch((error) => {
        log.error(
          "[versions] Failed to reset Liveblocks room after version create",
          {
            artifactId: resolvedId,
            version: updatedArtifact.latestVersion,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      });

      return successResponse(updatedArtifact);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to create new version", error);
    }
  },
  { requiredScopes: ["write"] }
);
