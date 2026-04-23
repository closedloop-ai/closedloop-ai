import type { DocumentDetail } from "@repo/api/src/types/document";
import type { DocumentVersion } from "@repo/api/src/types/document-version";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { DocumentNotFoundError } from "../../document-utils";
import { documentVersionService } from "../../document-version-service";
import { resetDocumentRoom } from "../../room-utils";
import { documentsService } from "../../service";
import { newVersionValidator } from "../../validators";

export const GET = withAnyAuth<
  Pick<
    DocumentVersion,
    "id" | "documentId" | "version" | "createdById" | "createdAt"
  >[],
  "/documents/[id]/versions"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    // Verify artifact exists and belongs to org
    const artifact = await documentsService.findByIdSimple(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    const versions = await documentVersionService.listVersions(resolvedId);
    return successResponse(versions);
  } catch (error) {
    return errorResponse("Failed to fetch artifact versions", error);
  }
});

export const POST = withAnyAuth<DocumentDetail, "/documents/[id]/versions">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
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

      const updatedArtifact = await documentsService.createNewVersion(
        resolvedId,
        user.organizationId,
        user.id,
        body.content
      );
      if (!updatedArtifact) {
        return notFoundResponse("Artifact");
      }

      // Reset the Liveblocks room when a new version is created.
      // This allows the room to be reset with the new content the next time a user opens the
      // artifact editor.
      const resetRoom =
        request.nextUrl.searchParams.get("reset-room") !== "false";
      if (resetRoom) {
        log.info("[liveblocks] Resetting room after version create", {
          documentId: resolvedId,
          version: updatedArtifact.latestVersion,
        });
        await resetDocumentRoom(updatedArtifact).catch((error) => {
          log.error("[liveblocks] Failed to reset room after version create", {
            documentId: resolvedId,
            version: updatedArtifact.latestVersion,
            error: error instanceof Error ? error.message : String(error),
          });
          scheduleLogFlush();
        });
      }

      scheduleLogFlush();
      return successResponse(updatedArtifact);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        return notFoundResponse("Artifact");
      }
      return errorResponse("Failed to create new version", error);
    }
  },
  { requiredScopes: ["write"] }
);
