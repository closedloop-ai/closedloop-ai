import type { ApiResult } from "@repo/api/src/types/common";
import { success } from "@repo/api/src/types/common";
import type { ExecutionBackendResponse } from "@repo/api/src/types/settings";
import { NextResponse } from "next/server";
import { computeModeService } from "@/app/settings/compute-mode-service";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<
  ExecutionBackendResponse,
  "/artifacts/[id]/execution-backend"
>(
  async (
    { user },
    _request,
    params
  ): Promise<NextResponse<ApiResult<ExecutionBackendResponse>>> => {
    try {
      const { id } = await params;
      const artifactId = await resolveArtifactId(id, user.organizationId);
      if (!artifactId) {
        return notFoundResponse("Artifact");
      }

      // Verify artifact exists and belongs to org
      const artifact = await artifactsService.findById(
        artifactId,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Determine backend based on execution history
      const backend = await artifactsService.resolveExecutionBackend(
        artifactId,
        user.organizationId,
        artifact.workstreamId
      );

      if (backend !== null) {
        return NextResponse.json(success(backend));
      }

      // No history — fall back to the org's configured compute mode
      const computeMode = await computeModeService.getComputeMode(
        user.organizationId
      );

      return NextResponse.json(
        success({ backend: computeMode, reason: "org_default" })
      );
    } catch (error) {
      return errorResponse("Failed to determine execution backend", error);
    }
  }
);
