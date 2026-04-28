import "server-only";

/**
 * Desktop-facing route for the second half of onboarding.
 *
 * Desktop presents a one-time onboarding attempt, the confirmed web origin,
 * and an optional Ed25519 public key to receive a managed desktop API key.
 */
import { z } from "zod";
import {
  apiKeysService,
  DesktopManagedKeyRotationConflictError,
} from "@/app/api-keys/service";
import { computeTargetsService } from "@/app/compute-targets/service";
import { uuidV4Validator } from "@/app/compute-targets/validators";
import {
  type BootstrapClaimResponse,
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { usersService } from "@/app/users/service";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";

const bootstrapClaimRequestValidator = z
  .object({
    onboardingAttemptId: z.string().trim().min(1).max(255),
    webAppOrigin: z.string().min(1).max(2048),
    gatewayId: uuidV4Validator,
    gatewayPublicKeyPem: z.string().trim().min(1).max(16_384).optional(),
    // Keep the legacy field name as a compatibility alias during staggered rollouts.
    gatewayPublicKey: z.string().trim().min(1).max(16_384).optional(),
  })
  .strict();

type BootstrapClaimRequest = z.infer<typeof bootstrapClaimRequestValidator>;
type BootstrapClaimAttempt = Awaited<
  ReturnType<typeof desktopOnboardingAttemptsService.get>
>;

/**
 * Returns the exact malformed-body error body required by the claim contract.
 */
function invalidClaimRequestResponse() {
  return desktopContractError(400, "INVALID_BOOTSTRAP_CLAIM_REQUEST", false);
}

async function readBootstrapClaimRequest(
  request: Request
): Promise<BootstrapClaimRequest | Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidClaimRequestResponse();
  }

  const parsedBody = bootstrapClaimRequestValidator.safeParse(rawBody);
  return parsedBody.success ? parsedBody.data : invalidClaimRequestResponse();
}

function normalizeGatewayPublicKey(
  body: BootstrapClaimRequest
): string | null | Response {
  if (body.gatewayPublicKeyPem) {
    const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
      body.gatewayPublicKeyPem
    );
    return (
      gatewayPublicKeyPem ??
      desktopContractError(400, "INVALID_GATEWAY_PUBLIC_KEY", false)
    );
  }

  if (body.gatewayPublicKey) {
    // Only the preferred v10 field is strict-validating; unusable legacy aliases
    // degrade to a null-bound DESKTOP_MANAGED key for version-skew safety.
    return normalizeEd25519SpkiPublicKeyPem(body.gatewayPublicKey) ?? null;
  }

  return null;
}

async function loadBootstrapClaimAttempt(
  onboardingAttemptId: string
): Promise<BootstrapClaimAttempt | Response> {
  try {
    return await desktopOnboardingAttemptsService.get(onboardingAttemptId);
  } catch {
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }
}

async function validateBoundClaimAttempt(
  attempt: NonNullable<BootstrapClaimAttempt>,
  body: BootstrapClaimRequest,
  webAppOrigin: string
): Promise<Response | null> {
  const now = new Date();
  if (attempt.consumedAt || attempt.expiresAt <= now) {
    return desktopContractError(
      401,
      "ONBOARDING_ATTEMPT_INVALID_OR_EXPIRED",
      false
    );
  }

  if (attempt.webAppOrigin !== webAppOrigin) {
    return desktopContractError(
      403,
      "ONBOARDING_ATTEMPT_ORIGIN_MISMATCH",
      false
    );
  }

  if (attempt.gatewayId && attempt.gatewayId !== body.gatewayId) {
    return desktopContractError(
      403,
      "ONBOARDING_ATTEMPT_GATEWAY_MISMATCH",
      false
    );
  }

  if (!attempt.computeTargetId) {
    return null;
  }

  try {
    const target = await computeTargetsService.findOwnedById(
      attempt.computeTargetId,
      attempt.organizationId,
      attempt.userId
    );
    return target && target.gatewayId === body.gatewayId
      ? null
      : desktopContractError(403, "ONBOARDING_ATTEMPT_GATEWAY_MISMATCH", false);
  } catch {
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }
}

/**
 * Exchanges a validated onboarding attempt for a desktop-managed API key.
 */
export async function POST(request: Request) {
  const body = await readBootstrapClaimRequest(request);
  if (body instanceof Response) {
    return body;
  }
  const webAppOrigin = canonicalizeTrustedOrigin(body.webAppOrigin);
  if (!webAppOrigin) {
    return invalidClaimRequestResponse();
  }

  const gatewayPublicKeyPem = normalizeGatewayPublicKey(body);
  if (gatewayPublicKeyPem instanceof Response) {
    return gatewayPublicKeyPem;
  }

  const attempt = await loadBootstrapClaimAttempt(body.onboardingAttemptId);
  if (attempt instanceof Response) {
    return attempt;
  }
  if (!attempt) {
    return desktopContractError(
      401,
      "ONBOARDING_ATTEMPT_INVALID_OR_EXPIRED",
      false
    );
  }
  let attemptUser: Awaited<ReturnType<typeof usersService.findById>>;
  try {
    attemptUser = await usersService.findById(
      attempt.userId,
      attempt.organizationId
    );
  } catch {
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }
  if (
    !(
      attemptUser?.active &&
      (await isDesktopManagedPopEnforcementEnabled({
        userId: attempt.userId,
        clerkUserId: attemptUser.clerkId,
      }))
    )
  ) {
    return desktopContractError(
      403,
      "DESKTOP_SECURITY_UPGRADE_DISABLED",
      false
    );
  }

  const validationError = await validateBoundClaimAttempt(
    attempt,
    body,
    webAppOrigin
  );
  if (validationError) {
    return validationError;
  }

  try {
    const consumed = await desktopOnboardingAttemptsService.consume(
      body.onboardingAttemptId
    );
    if (!consumed) {
      return desktopContractError(
        401,
        "ONBOARDING_ATTEMPT_INVALID_OR_EXPIRED",
        false
      );
    }
  } catch {
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }

  try {
    const managedKey = await apiKeysService.rotateDesktopManagedKey({
      organizationId: attempt.organizationId,
      userId: attempt.userId,
      gatewayId: body.gatewayId,
      boundPublicKey: gatewayPublicKeyPem,
    });

    return desktopContractSuccess<BootstrapClaimResponse>({
      apiKey: managedKey.plaintext,
      source: "DESKTOP_MANAGED",
      gatewayId: body.gatewayId,
    });
  } catch (error) {
    // The attempt is already consumed once rotation starts, so callers must
    // restart onboarding rather than blindly retrying the same claim.
    if (error instanceof DesktopManagedKeyRotationConflictError) {
      return desktopContractError(
        409,
        "DESKTOP_MANAGED_KEY_ROTATION_CONFLICT",
        false
      );
    }
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      false
    );
  }
}
