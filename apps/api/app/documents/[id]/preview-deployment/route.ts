import { success } from "@repo/api/src/types/common";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { NextResponse } from "next/server";
import { externalLinksService } from "@/app/external-links/service";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

/**
 * Get the preview deployment ExternalLink for an artifact's workstream.
 * Returns the first PREVIEW_DEPLOYMENT external link found for the workstream.
 */
export const GET = withAuth<ExternalLink | null, "/documents/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      // Find the artifact to get its workstreamId
      const artifact = await documentsService.findByIdSimple(
        resolvedId,
        user.organizationId
      );
      if (!artifact) {
        return notFoundResponse("Artifact");
      }
      if (!artifact.workstreamId) {
        return NextResponse.json(success(null));
      }

      const links = await externalLinksService.findByWorkstream(
        artifact.workstreamId,
        "PREVIEW_DEPLOYMENT"
      );

      return NextResponse.json(success(links[0] ?? null));
    } catch (error) {
      return errorResponse("Failed to fetch preview deployment", error);
    }
  }
);
