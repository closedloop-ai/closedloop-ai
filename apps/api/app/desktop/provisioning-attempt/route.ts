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
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

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
>(async ({ user }, request) => {
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

  if (!(await isDesktopManagedPopProvisioningEnabled(user.id, body.platform))) {
    return forbiddenResponse();
  }

  try {
    const attempt = await desktopOnboardingAttemptsService.create({
      organizationId: user.organizationId,
      userId: user.id,
      webAppOrigin,
    });

    return successResponse({
      onboardingAttemptId: attempt.onboardingAttemptId,
      expiresAt: attempt.expiresAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(
      "Failed to create Desktop provisioning attempt",
      error
    );
  }
});
