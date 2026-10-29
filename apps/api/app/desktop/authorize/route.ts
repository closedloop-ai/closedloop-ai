import "server-only";

import { z } from "zod";
import {
  DesktopConnectRejectionCause,
  DesktopConnectStage,
  desktopConnectRejected,
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopAuthorizeService } from "./service";

/**
 * POST /desktop/authorize — mint a one-time OAuth authorization code for the
 * desktop loopback flow (FEA-2409). Clerk-authed: called by the web authorize
 * page after the user consents. The returned code is carried by the browser to
 * the desktop's `redirect_uri` and redeemed at /desktop/authorize/token.
 */
const authorizeRequestValidator = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
    gatewayId: z.string().trim().min(1).max(255),
    gatewayPublicKeyPem: z.string().trim().min(1).max(4096),
    codeChallenge: z.string().trim().min(1).max(255),
    codeChallengeMethod: z.string().trim().min(1).max(16),
    redirectUri: z.string().trim().min(1).max(2048),
  })
  .strict();

async function handlePost(request: Request) {
  let session: Awaited<ReturnType<typeof resolveSessionUser>>;
  try {
    session = await resolveSessionUser();
  } catch {
    // A session lookup that FAILED is not an authorization decision, so it must
    // not wear one (ISS-5118). Reuses this route's existing retryable bucket
    // rather than adding a code — the contract deliberately collapses every
    // server-side failure into one 503. Identical shape to the sibling
    // /desktop/onboarding-attempt mint.
    //
    // That collapse is why this reports at all: on the wire an auth-provider
    // outage is indistinguishable from a mint fault, and `cause` is the only
    // server-side signal telling them apart. It rides the shared BOUNDED
    // emitter rather than a bare `log.error`, because this catch sits ahead of
    // any auth decision — so an unauthenticated caller can drive it once per
    // request for as long as the outage lasts, which is exactly the
    // amplification `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids.
    // Suppressed occurrences are rolled up, never discarded (#5958).
    return desktopConnectRejected(503, "DESKTOP_AUTHORIZE_FAILED", true, {
      stage: DesktopConnectStage.Authorize,
      cause: DesktopConnectRejectionCause.SessionLookupFaulted,
    });
  }
  if (!session) {
    return desktopContractError(401, "SESSION_REQUIRED", false);
  }

  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = authorizeRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DESKTOP_AUTHORIZE", false);
  }

  // CSRF defense-in-depth: this Clerk-cookie-authed mint must originate from the
  // trusted web app, matching its self-declared origin (mirrors the sibling
  // /desktop/onboarding-attempt and /desktop/provisioning-attempt mints).
  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  const requestOriginHeader = request.headers.get("origin");
  const requestOrigin = requestOriginHeader
    ? canonicalizeTrustedOrigin(requestOriginHeader)
    : null;
  if (!(webAppOrigin && requestOrigin && requestOrigin === webAppOrigin)) {
    return desktopContractError(403, "DESKTOP_AUTHORIZE_FORBIDDEN", false);
  }

  // Reject a malformed / non-Ed25519 device key at mint with a clear 400 rather
  // than persisting it and surfacing a misleading PoP failure at redeem
  // (mirrors /desktop/device-onboarding/start and bootstrap/claim).
  const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
    parsedBody.data.gatewayPublicKeyPem
  );
  if (!gatewayPublicKeyPem) {
    return desktopContractError(400, "INVALID_DESKTOP_AUTHORIZE", false);
  }

  const outcome = await desktopAuthorizeService
    .mint({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      gatewayId: parsedBody.data.gatewayId,
      gatewayPublicKeyPem,
      codeChallenge: parsedBody.data.codeChallenge,
      codeChallengeMethod: parsedBody.data.codeChallengeMethod,
      redirectUri: parsedBody.data.redirectUri,
    })
    .catch(() => null);

  if (outcome === null) {
    return desktopContractError(503, "DESKTOP_AUTHORIZE_FAILED", true);
  }
  if (!outcome.ok) {
    return desktopContractError(
      400,
      "DESKTOP_AUTHORIZE_INVALID_REQUEST",
      false
    );
  }

  return desktopContractSuccess(outcome.value);
}

export const POST = withRequestCompleted(handlePost);
