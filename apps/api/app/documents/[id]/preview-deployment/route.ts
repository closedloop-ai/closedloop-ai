import type { DeploymentArtifact } from "@repo/api/src/types/artifact";
import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { deploymentService } from "@/app/deployments/deployment-service";
import { deploymentArtifactToInfo } from "@/lib/artifact-adapters";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

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

    const deploymentArtifact =
      await deploymentService.findLatestPreviewForDocument(
        resolvedId,
        user.organizationId
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
