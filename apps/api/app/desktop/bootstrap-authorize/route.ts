import "server-only";

import { DesktopBootstrapErrorCode } from "@repo/api/src/types/desktop-bootstrap";
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
import { resolvePendingSessionPrincipal } from "@/lib/auth/pending-session-user";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopBootstrapSchemaReadinessService } from "./schema-readiness-service";
import { desktopBootstrapAuthorizeService } from "./service";

const requestValidator = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
    gatewayId: z.string().trim().min(1).max(255),
    gatewayPublicKeyPem: z.string().trim().min(1).max(4096),
    codeChallenge: z.string().trim().min(1).max(255),
    codeChallengeMethod: z.string().trim().min(1).max(16),
    redirectUri: z.string().trim().min(1).max(2048),
  })
  .strict();

export const POST = createDesktopBootstrapAuthorizeHandler();

async function handlePost(request: Request) {
  let principal: Awaited<ReturnType<typeof resolvePendingSessionPrincipal>>;
  try {
    principal = await resolvePendingSessionPrincipal();
  } catch {
    return desktopConnectRejected(503, DesktopBootstrapErrorCode.Failed, true, {
      stage: DesktopConnectStage.BootstrapAuthorize,
      cause: DesktopConnectRejectionCause.SessionLookupFaulted,
    });
  }
  if (!principal) {
    return desktopContractError(
      401,
      DesktopBootstrapErrorCode.PendingSessionRequired,
      false
    );
  }
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsed = requestValidator.safeParse(rawBody);
  if (!parsed.success) {
    return desktopContractError(
      400,
      DesktopBootstrapErrorCode.InvalidBody,
      false
    );
  }
  const declaredOrigin = canonicalizeTrustedOrigin(parsed.data.webAppOrigin);
  const header = request.headers.get("origin");
  const requestOrigin = header ? canonicalizeTrustedOrigin(header) : null;
  if (!(declaredOrigin && requestOrigin === declaredOrigin)) {
    return desktopContractError(
      403,
      DesktopBootstrapErrorCode.Forbidden,
      false
    );
  }
  const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
    parsed.data.gatewayPublicKeyPem
  );
  if (!gatewayPublicKeyPem) {
    return desktopContractError(
      400,
      DesktopBootstrapErrorCode.InvalidBody,
      false
    );
  }
  if (!(await desktopBootstrapSchemaReadinessService.isReady())) {
    return desktopContractError(503, DesktopBootstrapErrorCode.Failed, true);
  }
  const result = await desktopBootstrapAuthorizeService
    .mint({
      clerkUserId: principal.clerkUserId,
      gatewayId: parsed.data.gatewayId,
      gatewayPublicKeyPem,
      codeChallenge: parsed.data.codeChallenge,
      codeChallengeMethod: parsed.data.codeChallengeMethod,
      redirectUri: parsed.data.redirectUri,
    })
    .catch(() => null);
  if (!result) {
    return desktopContractError(503, DesktopBootstrapErrorCode.Failed, true);
  }
  if (!result.ok) {
    return desktopContractError(
      400,
      DesktopBootstrapErrorCode.ServiceRejected,
      false
    );
  }
  return desktopContractSuccess(result.value);
}

function createDesktopBootstrapAuthorizeHandler() {
  return withRequestCompleted(handlePost);
}
