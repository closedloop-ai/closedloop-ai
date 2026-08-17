import "server-only";

import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  apiKeysService,
  DesktopManagedKeyRotationConflictError,
} from "@/app/api-keys/service";
import { uuidValidator } from "@/app/compute-targets/validators";
import type { DesktopManagedKeyProvisionResponse } from "@/app/desktop/contract";
import { findActiveDeviceSession } from "@/app/desktop/session/service";
import { verifyDesktopSessionPop } from "@/lib/auth/desktop-session-pop";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
import type {
  AuthContext,
  AuthenticatedJsonResponse,
} from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/**
 * PRD-532 §5.5 (PR-K / M8): session-authenticated provisioning of the
 * DESKTOP_MANAGED relay `sk_live_*` key, bound to the device PoP public key.
 *
 * This replaces the user-pasted relay key in the unified auth flow. The desktop
 * signs in via the loopback browser flow, obtaining a first-party session; the
 * main process then calls this endpoint with a fresh PoP signature over the
 * request. We prove the caller still holds the device private key bound to their
 * live session (`verifyDesktopSessionPop` against the session's `boundPublicKey`)
 * and, on success, mint a DESKTOP_MANAGED key via the SHARED
 * `apiKeysService.rotateDesktopManagedKey` primitive — the exact same
 * revoke-then-mint used by the onboarding-attempt bootstrap claim. There is NO
 * parallel or weaker key mint here.
 *
 * Org/user are taken from the verified session (never the request body), so a
 * caller cannot provision for another org. Rotation is idempotent per device:
 * an existing active DESKTOP_MANAGED key for the same org/user/gateway is revoked
 * before the replacement is created, so repeated calls never accumulate keys.
 *
 * The plaintext key is returned once. Neither the key nor the PoP signature is
 * ever logged.
 */
const provisionRequestValidator = z
  .object({
    gatewayId: uuidValidator,
    gatewayPublicKeyPem: z.string().trim().min(1).max(16_384),
  })
  .strict();

export async function handleManagedKeyProvision(
  authContext: AuthContext,
  request: Request
): Promise<AuthenticatedJsonResponse<DesktopManagedKeyProvisionResponse>> {
  // Session-only: the DESKTOP_MANAGED key must bind to a device with a live
  // first-party session, so accepting anything but a desktop-session identity
  // would be a weaker credential path. `withDesktopSessionAuth` already
  // guarantees this, but re-assert defensively.
  if (authContext.authMethod !== "desktop_session") {
    return forbiddenResponse();
  }

  const { body, errorResponse: parseErrorResponse } = await parseBody(
    request,
    provisionRequestValidator
  );
  if (parseErrorResponse) {
    return parseErrorResponse;
  }

  const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
    body.gatewayPublicKeyPem
  );
  if (!gatewayPublicKeyPem) {
    return badRequestResponse("Invalid gateway public key");
  }

  const organizationId = authContext.user.organizationId;
  const userId = authContext.user.id;

  let session: Awaited<ReturnType<typeof findActiveDeviceSession>>;
  try {
    session = await findActiveDeviceSession({
      userId,
      organizationId,
      gatewayId: body.gatewayId,
    });
  } catch (error) {
    return errorResponse(
      "Failed to resolve desktop session for managed key provisioning",
      error
    );
  }

  // No live session for this device means no bound key to verify against — fail
  // closed rather than mint an unbound (weaker) DESKTOP_MANAGED key.
  if (!session) {
    return forbiddenResponse();
  }

  // The supplied device pubkey must match the key the live session is bound to;
  // otherwise a session holder could bind a managed key to an arbitrary key they
  // do not control. Both are normalized SPKI PEM so the comparison is canonical.
  const sessionBoundKey = normalizeEd25519SpkiPublicKeyPem(
    session.boundPublicKey
  );
  if (!sessionBoundKey || sessionBoundKey !== gatewayPublicKeyPem) {
    return forbiddenResponse();
  }

  const pop = verifyDesktopSessionPop({
    request,
    boundPublicKeyPem: session.boundPublicKey,
    expectedGatewayId: session.gatewayId,
  });
  if (!pop.ok) {
    log.warn("desktop_managed_key_provision_pop_rejected", {
      sessionId: session.id,
      gatewayId: session.gatewayId,
      reason: pop.reason,
    });
    return forbiddenResponse();
  }

  try {
    const managedKey = await apiKeysService.rotateDesktopManagedKey({
      organizationId,
      userId,
      gatewayId: body.gatewayId,
      boundPublicKey: gatewayPublicKeyPem,
    });

    // Audit trail: mint occurred. Never log the plaintext key.
    log.info("desktop_managed_key_provisioned", {
      apiKeyId: managedKey.id,
      organizationId,
      userId,
      gatewayId: body.gatewayId,
      sessionId: session.id,
    });

    return successResponse<DesktopManagedKeyProvisionResponse>({
      apiKey: managedKey.plaintext,
      source: "DESKTOP_MANAGED",
      gatewayId: body.gatewayId,
    });
  } catch (error) {
    if (error instanceof DesktopManagedKeyRotationConflictError) {
      // A concurrent provision won the single-active-key race; the caller should
      // retry, which will read the winner's key on the next verify.
      return errorResponse(
        "Concurrent desktop-managed key provisioning conflict",
        error,
        409
      );
    }
    return errorResponse("Failed to provision desktop-managed key", error);
  }
}
