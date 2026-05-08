import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { onboardingService } from "./service";

/**
 * GET /onboarding - Get onboarding status for the current organization
 */
export const GET = withAnyAuth<OnboardingStatus, "/onboarding">(
  async ({ user }) => {
    try {
      const status = await onboardingService.getStatus(user.organizationId);
      return successResponse(status);
    } catch (error) {
      return errorResponse("Failed to fetch onboarding status", error);
    }
  }
);
