import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { recordOnboardingWrite } from "../onboarding-receipt";
import { onboardingService } from "../service";

const completeWizardValidator = z.object({
  createdTeamId: z.string().optional(),
  createdProjectId: z.string().optional(),
});

/**
 * PUT /onboarding/complete-wizard - Mark the onboarding wizard as completed
 */
export const PUT = withAnyAuth<OnboardingStatus, "/onboarding/complete-wizard">(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
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
          body.createdProjectId,
          recordOnboardingWrite(receipts)
        );

        return successResponse(withOperationReceipt(status, receipts));
      } catch (error) {
        return errorResponse("Failed to complete onboarding wizard", error);
      }
    }
  )
);
