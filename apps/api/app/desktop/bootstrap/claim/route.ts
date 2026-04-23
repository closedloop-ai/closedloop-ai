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
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";

const bootstrapClaimRequestValidator = z
  .object({
    onboardingAttemptId: z.string().trim().min(1).max(255),
    webAppOrigin: z.string().min(1).max(2048),
    gatewayId: z
      .string()
      .trim()
      .uuid()
      .refine(
        (value) =>
          value[14] === "4" &&
          ["8", "9", "a", "b", "A", "B"].includes(value[19] ?? ""),
        { message: "gatewayId must be a UUID v4" }
      ),
    gatewayPublicKeyPem: z.string().trim().min(1).max(16_384).optional(),
    // Keep the legacy field name as a compatibility alias during staggered rollouts.
    gatewayPublicKey: z.string().trim().min(1).max(16_384).optional(),
  })
  .strict();

type BootstrapClaimResponse = {
  apiKey: string;
  source: "DESKTOP_MANAGED";
  gatewayId: string;
};

/**
 * Returns the exact malformed-body error body required by the claim contract.
 */
function invalidClaimRequestResponse() {
  return desktopContractError(400, "INVALID_BOOTSTRAP_CLAIM_REQUEST", false);
}

/**
 * Exchanges a validated onboarding attempt for a desktop-managed API key.
 */
export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return invalidClaimRequestResponse();
  }

  const parsedBody = bootstrapClaimRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return invalidClaimRequestResponse();
  }

  const body = parsedBody.data;
  const webAppOrigin = canonicalizeTrustedOrigin(body.webAppOrigin);
  if (!webAppOrigin) {
    return invalidClaimRequestResponse();
  }

  const requestedGatewayPublicKey =
    body.gatewayPublicKeyPem ?? body.gatewayPublicKey ?? null;
  const gatewayPublicKeyPem = requestedGatewayPublicKey
    ? normalizeEd25519SpkiPublicKeyPem(requestedGatewayPublicKey)
    : null;
  if (requestedGatewayPublicKey && !gatewayPublicKeyPem) {
    return desktopContractError(400, "INVALID_GATEWAY_PUBLIC_KEY", false);
  }

  let attempt: Awaited<ReturnType<typeof desktopOnboardingAttemptsService.get>>;
  try {
    attempt = await desktopOnboardingAttemptsService.get(
      body.onboardingAttemptId
    );
  } catch {
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }

  const now = new Date();
  if (!attempt || attempt.consumedAt || attempt.expiresAt <= now) {
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
    if (error instanceof DesktopManagedKeyRotationConflictError) {
      return desktopContractError(
        409,
        "DESKTOP_MANAGED_KEY_ROTATION_CONFLICT",
        true
      );
    }
    return desktopContractError(
      503,
      "DESKTOP_MANAGED_KEY_ISSUANCE_FAILED",
      true
    );
  }
}
