import type { DistributionDto } from "@repo/api/src/types/distribution";
import { computeTargetsService } from "@/app/compute-targets/service";
import { distributionsService } from "@/app/distributions/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";

/**
 * GET /desktop/distributions/assigned?computeTargetId=<id>
 *
 * Returns all distributions assigned to the given compute target
 * (auto_install + opt_in, all-targeting or specific-targeting matching this target/user).
 *
 * For `auto_install` distributions with a zip asset, each row carries a 15-minute
 * presigned S3 download URL in `assetDownloadUrl`.
 *
 * Authentication: `withAnyAuth` (API-key, desktop-session, or Clerk session).
 * Authorization: ComputeTarget ownership gate (NOT admin-only).
 */
export const GET = withAnyAuth<
  DistributionDto[],
  "/desktop/distributions/assigned"
>(
  async ({ user, clerkUserId }, request) => {
    const computeTargetId = new URL(request.url).searchParams
      .get("computeTargetId")
      ?.trim();
    if (!computeTargetId) {
      return badRequestResponse("computeTargetId is required");
    }

    // Verify the compute target belongs to the calling user + org.
    const target = await computeTargetsService.findOwnedById(
      computeTargetId,
      user.organizationId,
      user.id,
      clerkUserId
    );
    if (!target) {
      return forbiddenResponse();
    }

    try {
      const distributions = await distributionsService.getAssignedForTarget(
        user.organizationId,
        computeTargetId,
        user.id
      );
      return successResponse(distributions);
    } catch (error) {
      return errorResponse("Failed to fetch assigned distributions", error);
    }
  },
  { requiredScopes: ["read"] }
);
