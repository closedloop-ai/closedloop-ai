import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { onboardingService } from "../service";

/**
 * PUT /onboarding/dismiss-checklist - Dismiss the onboarding checklist
 */
export const PUT = withAnyAuth<
  OnboardingStatus,
  "/onboarding/dismiss-checklist"
>(async ({ user }) => {
  try {
    const status = await onboardingService.dismissChecklist(
      user.organizationId
    );

    return successResponse(status);
  } catch (error) {
    return errorResponse("Failed to dismiss onboarding checklist", error);
  }
});
