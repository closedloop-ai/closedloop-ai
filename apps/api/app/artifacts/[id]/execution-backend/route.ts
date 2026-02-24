import type { ApiResult } from "@repo/api/src/types/common";
import { success } from "@repo/api/src/types/common";
import type { ExecutionBackendResponse } from "@repo/api/src/types/settings";
import { withDb } from "@repo/database";
import { NextResponse } from "next/server";
import { computeModeService } from "@/app/settings/compute-mode-service";
import { withAuth } from "@/lib/auth/with-auth";
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
      const { id: artifactId } = await params;

      // Verify artifact exists and belongs to org
      const artifact = await artifactsService.findById(
        artifactId,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Check for the earliest completed Loop for this artifact.
      // The first backend used for planning is the canonical one — we cannot
      // migrate state between Loops and GH Actions.
      const earliestLoop = await withDb((db) =>
        db.loop.findFirst({
          where: {
            artifactId,
            organizationId: user.organizationId,
            status: "COMPLETED",
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, createdAt: true },
        })
      );

      // Check for the earliest successful GitHubActionRun for this artifact.
      // GitHubActionRun links to artifacts via triggerData JSON, not a direct foreign key.
      // Requires workstreamId — skip if the artifact has none.
      const earliestGhActionRun = artifact.workstreamId
        ? await withDb((db) =>
            db.gitHubActionRun.findFirst({
              where: {
                workstreamId: artifact.workstreamId as string,
                status: {
                  in: ["PENDING", "QUEUED", "RUNNING", "SUCCESS"],
                },
                triggerData: { path: ["artifactId"], equals: artifactId },
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, createdAt: true },
            })
          )
        : null;

      // Determine backend based on execution history
      const backend = resolveBackend(earliestLoop, earliestGhActionRun);
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

/**
 * Pick the backend that was used first for this artifact.
 * State cannot migrate between Loops and GH Actions, so the original
 * planning backend is canonical for all subsequent operations.
 * Returns null when neither record exists (caller should fall back to org default).
 */
function resolveBackend(
  earliestLoop: { id: string; createdAt: Date } | null,
  earliestGhActionRun: { id: string; createdAt: Date } | null
): ExecutionBackendResponse | null {
  if (!(earliestLoop || earliestGhActionRun)) {
    return null;
  }

  if (earliestLoop && !earliestGhActionRun) {
    return { backend: "LOOPS", reason: "loop_history" };
  }

  if (!earliestLoop && earliestGhActionRun) {
    return { backend: "GITHUB_ACTIONS", reason: "github_action_history" };
  }

  // Both exist — whichever was created first is the original backend
  const loopTime = earliestLoop!.createdAt.getTime();
  const ghActionTime = earliestGhActionRun!.createdAt.getTime();

  if (loopTime <= ghActionTime) {
    return { backend: "LOOPS", reason: "loop_history" };
  }

  return { backend: "GITHUB_ACTIONS", reason: "github_action_history" };
}
