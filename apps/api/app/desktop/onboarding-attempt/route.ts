import "server-only";

/**
 * Browser-facing route for the first half of desktop onboarding.
 *
 * The authenticated web app creates a single-use onboarding attempt that the
 * installer/Desktop flow can hand off and later exchange for a managed API key.
 */
import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { desktopOnboardingAttemptsService } from "./service";

const onboardingAttemptRequestValidator = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
  })
  .strict();

type OnboardingAttemptResponse = {
  onboardingAttemptId: string;
  expiresAt: string;
};

function invalidRequestResponse() {
  return desktopContractError(400, "INVALID_ONBOARDING_ATTEMPT_REQUEST", false);
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof resolveSessionUser>>;
  try {
    session = await resolveSessionUser();
  } catch {
    // The contract exposes a single retryable 503 bucket for server-side failures.
    return desktopContractError(503, "ONBOARDING_ATTEMPT_PERSIST_FAILED", true);
  }

  if (!session) {
    return desktopContractError(401, "SESSION_REQUIRED", false);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidRequestResponse();
  }

  const parsedBody = onboardingAttemptRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return invalidRequestResponse();
  }

  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  const requestOriginHeader = request.headers.get("origin");
  const requestOrigin = requestOriginHeader
    ? canonicalizeTrustedOrigin(requestOriginHeader)
    : null;

  if (!(webAppOrigin && requestOrigin && requestOrigin === webAppOrigin)) {
    return desktopContractError(403, "ONBOARDING_ATTEMPT_FORBIDDEN", false);
  }

  try {
    const attempt = await desktopOnboardingAttemptsService.create({
      organizationId: session.user.organizationId,
      userId: session.user.id,
      webAppOrigin,
    });

    return desktopContractSuccess<OnboardingAttemptResponse>({
      onboardingAttemptId: attempt.onboardingAttemptId,
      expiresAt: attempt.expiresAt.toISOString(),
    });
  } catch {
    return desktopContractError(503, "ONBOARDING_ATTEMPT_PERSIST_FAILED", true);
  }
}
