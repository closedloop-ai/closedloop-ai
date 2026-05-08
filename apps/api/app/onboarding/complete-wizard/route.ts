import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { onboardingService } from "../service";

const completeWizardValidator = z.object({
  createdTeamId: z.string().optional(),
  createdProjectId: z.string().optional(),
});

/**
 * PUT /onboarding/complete-wizard - Mark the onboarding wizard as completed
 */
export const PUT = withAnyAuth<OnboardingStatus, "/onboarding/complete-wizard">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        completeWizardValidator
      );

      if (parseError) {
        return parseError;
      }

      const status = await onboardingService.completeWizard(
        user.organizationId,
        user.id,
        body.createdTeamId,
        body.createdProjectId
      );

      return successResponse(status);
    } catch (error) {
      return errorResponse("Failed to complete onboarding wizard", error);
    }
  }
);
