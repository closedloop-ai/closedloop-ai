import type { ComputeTargetHeartbeatResponse } from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../../service";

/**
 * POST /compute-targets/:id/heartbeat
 * Updates last-seen and marks target online.
 */
export const POST = withAnyAuth<
  ComputeTargetHeartbeatResponse,
  "/compute-targets/[id]/heartbeat"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;

    const ok = await computeTargetsService.heartbeat(
      id,
      user.organizationId,
      user.id
    );
    if (!ok) {
      return forbiddenResponse();
    }

    return successResponse({ ok: true });
  } catch (error) {
    return errorResponse("Failed to heartbeat compute target", error);
  }
});
