import "server-only";

/**
 * Browser-facing route for the first half of desktop onboarding.
 *
 * The authenticated web app creates a single-use onboarding attempt that the
 * installer/Desktop flow can hand off and later exchange for a managed API key.
 */
import { z } from "zod";
import {
  DesktopConnectRejectionCause,
  DesktopConnectStage,
  desktopConnectRejected,
  desktopContractSuccess,
  type OnboardingAttemptResponse,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopOnboardingAttemptsService } from "./service";

const onboardingAttemptRequestValidator = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
    platform: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

function invalidRequestResponse(orgId: string) {
  return desktopConnectRejected(
    400,
    "INVALID_ONBOARDING_ATTEMPT_REQUEST",
    false,
    { stage: DesktopConnectStage.OnboardingAttempt, orgId }
  );
}

async function handlePost(request: Request) {
  let session: Awaited<ReturnType<typeof resolveSessionUser>>;
  try {
    session = await resolveSessionUser();
  } catch {
    // The contract exposes a single retryable 503 bucket for server-side failures.
    // `cause` keeps the counter from reading an auth-provider outage as a
    // confirmed persistence failure — the wire code cannot tell them apart.
    return desktopConnectRejected(
      503,
      "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      true,
      {
        stage: DesktopConnectStage.OnboardingAttempt,
        cause: DesktopConnectRejectionCause.SessionLookupFaulted,
      }
    );
  }

  if (!session) {
    return desktopConnectRejected(401, "SESSION_REQUIRED", false, {
      stage: DesktopConnectStage.OnboardingAttempt,
    });
  }

  const orgId = session.user.organizationId;

  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );

  const parsedBody = onboardingAttemptRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return invalidRequestResponse(orgId);
  }

  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  const requestOriginHeader = request.headers.get("origin");
  const requestOrigin = requestOriginHeader
    ? canonicalizeTrustedOrigin(requestOriginHeader)
    : null;

  if (!(webAppOrigin && requestOrigin && requestOrigin === webAppOrigin)) {
    return desktopConnectRejected(403, "ONBOARDING_ATTEMPT_FORBIDDEN", false, {
      stage: DesktopConnectStage.OnboardingAttempt,
      orgId,
    });
  }

  try {
    const attempt = await desktopOnboardingAttemptsService.create({
      organizationId: orgId,
      userId: session.user.id,
      webAppOrigin,
    });

    return desktopContractSuccess<OnboardingAttemptResponse>({
      onboardingAttemptId: attempt.onboardingAttemptId,
      expiresAt: attempt.expiresAt.toISOString(),
    });
  } catch {
    return desktopConnectRejected(
      503,
      "ONBOARDING_ATTEMPT_PERSIST_FAILED",
      true,
      {
        stage: DesktopConnectStage.OnboardingAttempt,
        orgId,
        cause: DesktopConnectRejectionCause.AttemptPersistFaulted,
      }
    );
  }
}

export const POST = withRequestCompleted(handlePost);
