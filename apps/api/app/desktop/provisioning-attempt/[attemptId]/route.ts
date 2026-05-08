import type { DesktopProvisioningAttemptStatusResponse } from "@repo/api/src/types/electron";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { desktopOnboardingAttemptsService } from "../../onboarding-attempt/service";

/**
 * GET /desktop/provisioning-attempt/:attemptId
 * Returns the authenticated user's installer provisioning status.
 */
export const GET = withAnyAuth<
  DesktopProvisioningAttemptStatusResponse,
  "/desktop/provisioning-attempt/[attemptId]"
>(async ({ user }, _request, params) => {
  const { attemptId } = await params;
  const trimmedAttemptId = attemptId.trim();
  if (!trimmedAttemptId) {
    return badRequestResponse("Invalid attempt ID");
  }

  try {
    const status = await desktopOnboardingAttemptsService.getStatus(
      trimmedAttemptId,
      user.organizationId,
      user.id
    );
    if (!status) {
      return notFoundResponse("Desktop provisioning attempt");
    }
    return successResponse(status);
  } catch (error) {
    return errorResponse("Failed to fetch Desktop provisioning status", error);
  }
});
