import "server-only";

import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { desktopDeviceOnboardingService } from "../service";

export async function GET(request: Request) {
  const session = await resolveSessionUser().catch(() => null);
  if (!session) {
    return desktopContractError(401, "SESSION_REQUIRED", false);
  }

  const code = new URL(request.url).searchParams
    .get("code")
    ?.trim()
    .toUpperCase();
  if (!code) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_CODE", false);
  }

  const row = await desktopDeviceOnboardingService
    .getByUserCode(code)
    .catch(() => undefined);
  if (row === undefined) {
    return desktopContractError(503, "DEVICE_SESSION_LOOKUP_FAILED", true);
  }
  if (!row || row.expiresAt <= new Date()) {
    return desktopContractError(404, "DEVICE_SESSION_NOT_FOUND", false);
  }

  return desktopContractSuccess({
    userCode: row.userCode,
    machineName: row.machineName,
    platform: row.platform,
    webAppOrigin: row.webAppOrigin,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  });
}
