import "server-only";

import { z } from "zod";
import { uuidValidator } from "@/app/compute-targets/validators";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { normalizeEd25519SpkiPublicKeyPem } from "@/lib/auth/ed25519-spki-pem";
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

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const parsedBody = startRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_REQUEST", false);
  }

  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  const gatewayPublicKeyPem = normalizeEd25519SpkiPublicKeyPem(
    parsedBody.data.gatewayPublicKeyPem
  );
  if (!(webAppOrigin && gatewayPublicKeyPem)) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_REQUEST", false);
  }

  try {
    const result = await desktopDeviceOnboardingService.start({
      ...parsedBody.data,
      webAppOrigin,
      gatewayPublicKeyPem,
      requestIp: getRequestIp(request),
    });
    if (result.status === "rate_limited") {
      return desktopContractError(429, "DEVICE_SESSION_RATE_LIMITED", true);
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
    return desktopContractError(503, "DEVICE_SESSION_PERSIST_FAILED", true);
  }
}
