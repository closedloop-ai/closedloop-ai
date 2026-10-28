import "server-only";

import { z } from "zod";
import { uuidValidator } from "@/app/compute-targets/validators";
import {
  DesktopConnectStage,
  desktopConnectRejected,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { desktopDeviceOnboardingService } from "../service";

const startRequestValidator = z
  .object({
    webAppOrigin: z.string().trim().min(1).max(2048),
    gatewayId: uuidValidator,
    gatewayPublicKeyPem: z.string().trim().min(1).max(16_384),
    machineName: z.string().trim().min(1).max(120),
    platform: z.string().trim().min(1).max(80),
    desktopVersion: z.string().trim().min(1).max(120),
    desktopSecurityUpgradeProtocolVersion: z.literal(1),
  })
  .strict();

function getRequestIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || null;
  }
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    null
  );
}

async function handlePost(request: Request) {
  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = startRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return invalidStartRequestResponse();
  }

  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
    parsedBody.data.gatewayPublicKeyPem
  );
  if (!(webAppOrigin && gatewayPublicKeyPem)) {
    return invalidStartRequestResponse();
  }

  try {
    const result = await desktopDeviceOnboardingService.start({
      ...parsedBody.data,
      webAppOrigin,
      gatewayPublicKeyPem,
      requestIp: getRequestIp(request),
    });
    if (result.status === "rate_limited") {
      return desktopConnectRejected(429, "DEVICE_SESSION_RATE_LIMITED", true, {
        stage: DesktopConnectStage.DeviceOnboardingStart,
      });
    }
    return desktopContractSuccess({
      deviceSessionId: result.deviceSessionId,
      deviceSessionSecret: result.deviceSessionSecret,
      userCode: result.userCode,
      verificationUrl: result.verificationUrl,
      expiresAt: result.expiresAt.toISOString(),
      pollIntervalSeconds: result.pollIntervalSeconds,
    });
  } catch {
    return desktopConnectRejected(503, "DEVICE_SESSION_PERSIST_FAILED", true, {
      stage: DesktopConnectStage.DeviceOnboardingStart,
    });
  }
}

function invalidStartRequestResponse() {
  return desktopConnectRejected(400, "INVALID_DEVICE_SESSION_REQUEST", false, {
    stage: DesktopConnectStage.DeviceOnboardingStart,
  });
}

export const POST = withRequestCompleted(handlePost);
