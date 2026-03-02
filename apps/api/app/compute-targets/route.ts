import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "./service";

/**
 * GET /compute-targets
 * Lists compute targets owned by the authenticated user.
 */
export const GET = withAnyAuth<ComputeTarget[], "/compute-targets">(
  async ({ user }) => {
    try {
      // Staleness safety-net: ensure old heartbeats do not remain online forever.
      await computeTargetsService.markStaleTargetsOffline({
        organizationId: user.organizationId,
        userId: user.id,
      });

      const targets = await computeTargetsService.listByOwner(
        user.organizationId,
        user.id
      );

      return successResponse(targets);
    } catch (error) {
      return errorResponse("Failed to fetch compute targets", error);
    }
  }
);
