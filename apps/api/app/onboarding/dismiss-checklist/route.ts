import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { recordOnboardingWrite } from "../onboarding-receipt";
import { onboardingService } from "../service";

/**
 * PUT /onboarding/dismiss-checklist - Dismiss the onboarding checklist
 */
export const PUT = withAnyAuth<
  OnboardingStatus,
  "/onboarding/dismiss-checklist"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, _request, _params, receipts) => {
      try {
        const status = await onboardingService.dismissChecklist(
          user.organizationId,
          user.id,
          recordOnboardingWrite(receipts)
        );

        return successResponse(withOperationReceipt(status, receipts));
      } catch (error) {
        return errorResponse("Failed to dismiss onboarding checklist", error);
      }
    }
  )
);
