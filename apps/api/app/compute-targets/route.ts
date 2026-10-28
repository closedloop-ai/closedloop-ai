import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { waitUntil } from "@vercel/functions";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "./service";

/**
 * GET /compute-targets
 * Lists the authenticated user's own compute targets (owner-only since
 * ISS-12617 retired target sharing).
 */
export const GET = withAnyAuth<ComputeTarget[], "/compute-targets">(
  async ({ user }) => {
    try {
      // Staleness safety-net: sweep the entire org, so teammates' targets
      // (read org-wide by the status stream and the Sessions onboarding check)
      // are also marked offline when heartbeats expire.
      waitUntil(
        computeTargetsService
          .markStaleTargetsOffline({
            organizationId: user.organizationId,
          })
          .catch(() => {})
      );

      const targets = await computeTargetsService.listAvailableForOrg(
        user.organizationId,
        user.id,
        user.clerkId
      );

      return successResponse(targets);
    } catch (error) {
      return errorResponse("Failed to fetch compute targets", error);
    }
  }
);
