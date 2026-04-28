import "server-only";

import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { desktopDeviceOnboardingService } from "../service";

const approvalRequestValidator = z
  .object({
    userCode: z.string().trim().min(4).max(16),
    action: z.enum(["approve", "deny"]),
  })
  .strict();

export async function POST(request: Request) {
  const session = await resolveSessionUser().catch(() => null);
  if (!session) {
    return desktopContractError(401, "SESSION_REQUIRED", false);
  }

  const rawBody = await request.json().catch(() => null);
  const parsedBody = approvalRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_APPROVAL", false);
  }

  const userCode = parsedBody.data.userCode.toUpperCase();
  if (
    parsedBody.data.action === "approve" &&
    !(await isDesktopManagedPopEnforcementEnabled({
      userId: session.user.id,
      clerkUserId: session.clerkUserId,
    }))
  ) {
    return desktopContractError(
      403,
      "DESKTOP_SECURITY_UPGRADE_DISABLED",
      false
    );
  }

  const row = await (parsedBody.data.action === "approve"
    ? desktopDeviceOnboardingService.approve({
        userCode,
        organizationId: session.user.organizationId,
        userId: session.user.id,
      })
    : desktopDeviceOnboardingService.deny(userCode)
  ).catch(() => undefined);

  if (row === undefined) {
    return desktopContractError(503, "DEVICE_SESSION_APPROVAL_FAILED", true);
  }

  if (!row) {
    return desktopContractError(404, "DEVICE_SESSION_NOT_FOUND", false);
  }

  return desktopContractSuccess({
    status: row.status,
    machineName: row.machineName,
    platform: row.platform,
    webAppOrigin: row.webAppOrigin,
  });
}
