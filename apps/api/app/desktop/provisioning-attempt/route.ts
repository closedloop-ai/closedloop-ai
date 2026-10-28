import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { DesktopProvisioningAttempt } from "@repo/api/src/types/electron";
import { z } from "zod";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "@/lib/desktop-managed-pop-provisioning";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { writeInShape } from "@/lib/record-write-in-transaction";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { provisioningAttemptReceiptWrite } from "./provisioning-attempt-receipt";

const provisioningAttemptRequest = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
    platform: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * POST /desktop/provisioning-attempt
 * Creates a single-use attempt for the web-app-generated installer command.
 */
export const POST = withAnyAuth<
  DesktopProvisioningAttempt,
  "/desktop/provisioning-attempt"
>(
  withOperationReceipts(
    OperationKind.SettingsWrite,
    async ({ user }, request, _params, receipts) => {
      const { body, errorResponse: parseErrorResponse } = await parseBody(
        request,
        provisioningAttemptRequest
      );
      if (parseErrorResponse) {
        return parseErrorResponse;
      }

      const webAppOrigin = canonicalizeTrustedOrigin(body.webAppOrigin);
      const requestOriginHeader = request.headers.get("origin");
      const requestOrigin = requestOriginHeader
        ? canonicalizeTrustedOrigin(requestOriginHeader)
        : null;
      if (
        !webAppOrigin ||
        (requestOriginHeader !== null && requestOrigin !== webAppOrigin)
      ) {
        return forbiddenResponse();
      }

      if (!isDesktopManagedPopPlatformSupported(body.platform)) {
        return forbiddenResponse();
      }

      if (
        !(await isDesktopManagedPopProvisioningEnabled(
          { userId: user.id, clerkUserId: user.clerkId },
          body.platform
        ))
      ) {
        return forbiddenResponse();
      }

      try {
        const input = {
          organizationId: user.organizationId,
          userId: user.id,
          webAppOrigin,
        };
        const attempt = await writeInShape(
          receipts.whenRecording((tx) =>
            receipts.record(tx, provisioningAttemptReceiptWrite())
          ),
          {
            unrecorded: () => desktopOnboardingAttemptsService.create(input),
            recorded: (recordWrite) =>
              desktopOnboardingAttemptsService.create(input, recordWrite),
          }
        );

        return successResponse(
          withOperationReceipt(
            {
              onboardingAttemptId: attempt.onboardingAttemptId,
              expiresAt: attempt.expiresAt.toISOString(),
            },
            receipts
          )
        );
      } catch (error) {
        return errorResponse(
          "Failed to create Desktop provisioning attempt",
          error
        );
      }
    }
  )
);
