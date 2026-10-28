import type { ComputeTargetHealthCheckSnapshot } from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "../../service";

/**
 * GET /compute-targets/:id/health-check
 * Returns the latest persisted health-check snapshot for an accessible target.
 */
export const GET = withAnyAuth<
  ComputeTargetHealthCheckSnapshot | null,
  "/compute-targets/[id]/health-check"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const snapshot = await computeTargetsService.getLatestHealthCheckForTarget(
      user.organizationId,
      user.id,
      id
    );
    return successResponse(snapshot);
  } catch (error) {
    return errorResponse("Failed to fetch compute target health check", error);
  }
});
