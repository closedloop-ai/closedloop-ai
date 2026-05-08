import type { DesktopProvisioningReadinessResponse } from "@repo/api/src/types/electron";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { desktopOnboardingAttemptsService } from "../onboarding-attempt/service";

/**
 * GET /desktop/provisioning-readiness
 * Returns whether the authenticated user already has an online protected
 * Desktop-managed target, independent of localhost health detection.
 */
export const GET = withAnyAuth<
  DesktopProvisioningReadinessResponse,
  "/desktop/provisioning-readiness"
>(async ({ user }) => {
  try {
    const readiness = await desktopOnboardingAttemptsService.getReadiness(
      user.organizationId,
      user.id
    );
    return successResponse(readiness);
  } catch (error) {
    return errorResponse(
      "Failed to fetch Desktop provisioning readiness",
      error
    );
  }
});
