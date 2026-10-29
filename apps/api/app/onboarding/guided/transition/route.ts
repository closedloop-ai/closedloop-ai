import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  GUIDED_ONBOARDING_UNREACHABLE_STATE_ERROR,
  type GuidedOnboardingTransitionResponse,
  guidedOnboardingTransitionRequestSchema,
} from "@repo/api/src/types/onboarding-guided";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { recordOnboardingWrite } from "../../onboarding-receipt";
import { staleRevisionResponse } from "../route-helpers";
import { recordReplayedTransitionReceipt } from "../transition-receipt";
import { guidedOnboardingTransitionService } from "../transition-service";

/**
 * POST /onboarding/guided/transition - persist one accepted transition.
 *
 * A stale `revision` answers 409 with the current snapshot; a redelivered
 * `commandId` answers 200 with it, because a duplicate delivery of a command
 * that already landed is a no-op rather than an error. A state the machine
 * cannot produce answers 400 with nothing persisted.
 *
 * The snapshot on a 200 or a 409 is `null` when composing it failed. The write
 * outcome is already decided at that point and, on a 200, already durable, so
 * it is reported truthfully and the client re-reads through GET.
 */
export const POST = withAnyAuth<
  GuidedOnboardingTransitionResponse,
  "/onboarding/guided/transition"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
      const parsed = await parseBody(
        request,
        guidedOnboardingTransitionRequestSchema
      );
      if (parsed.errorResponse) {
        return parsed.errorResponse;
      }

      try {
        const result = await guidedOnboardingTransitionService.apply(
          {
            organizationId: user.organizationId,
            userId: user.id,
            clerkUserId: user.clerkId,
            command: parsed.body,
          },
          recordOnboardingWrite(receipts)
        );
        if (result.ok) {
          await recordReplayedTransitionReceipt(result.value, receipts);
          const { snapshot } = result.value;
          return successResponse(
            snapshot && withOperationReceipt(snapshot, receipts)
          );
        }
        if (result.error.status === Status.Conflict) {
          return staleRevisionResponse(result.error.snapshot);
        }
        return badRequestResponse(GUIDED_ONBOARDING_UNREACHABLE_STATE_ERROR);
      } catch (error) {
        return errorResponse(
          "Failed to apply guided onboarding transition",
          error
        );
      }
    }
  )
);
