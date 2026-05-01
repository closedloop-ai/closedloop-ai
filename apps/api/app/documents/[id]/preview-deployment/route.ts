import type { DeploymentArtifact } from "@repo/api/src/types/artifact";
import { success } from "@repo/api/src/types/common";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { documentService } from "@/app/documents/document-service";
import {
  deploymentArtifactToInfo,
  deploymentWhere,
} from "@/lib/artifact-adapters";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

/**
 * Get the most recent preview-deployment artifact for a document's workstream.
 */
export const GET = withAuth<
  DeploymentArtifact | null,
  "/documents/[id]/preview-deployment"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const artifact = await documentService.findByIdSimple(
      resolvedId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }
    if (!artifact.workstreamId) {
      return NextResponse.json(success(null));
    }

    const deploymentArtifact = await withDb((db) =>
      db.artifact.findFirst({
        where: deploymentWhere({
          organizationId: user.organizationId,
          workstreamId: artifact.workstreamId,
        }),
        include: { deployment: true },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!deploymentArtifact) {
      return NextResponse.json(success(null));
    }

    return NextResponse.json(
      success(deploymentArtifactToInfo(deploymentArtifact))
    );
  } catch (error) {
    return errorResponse("Failed to fetch preview deployment", error);
  }
});
