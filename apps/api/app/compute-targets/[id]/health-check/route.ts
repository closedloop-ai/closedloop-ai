import type {
  ComputeTargetHealthCheckSnapshot,
  UpsertComputeTargetHealthCheckSnapshotInput,
} from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { computeTargetsService } from "../../service";
import { healthCheckSnapshotValidator } from "../../validators";

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

/**
 * PUT /compute-targets/:id/health-check
 * Stores the latest health-check snapshot for an accessible target.
 */
export const PUT = withAnyAuth<
  ComputeTargetHealthCheckSnapshot,
  "/compute-targets/[id]/health-check"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      healthCheckSnapshotValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      user.organizationId,
      user.id,
      id,
      body as UpsertComputeTargetHealthCheckSnapshotInput
    );
    if (!snapshot) {
      return notFoundResponse("Compute target");
    }

    return successResponse(snapshot);
  } catch (error) {
    return errorResponse("Failed to store compute target health check", error);
  }
});
