import "server-only";

import { z } from "zod";
import {
  desktopContractError,
  desktopContractSuccess,
} from "@/app/desktop/contract";
import {
  DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES,
  readBoundedJsonBody,
} from "@/app/desktop/route-helpers";
import { evaluateDesktopManagedPopEnforcement } from "@/lib/auth/desktop-managed-pop";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { popEnforcementRejection } from "../device-onboarding-route-helpers";
import { desktopDeviceOnboardingService } from "../service";

const approvalRequestValidator = z
  .object({
    userCode: z.string().trim().min(4).max(16),
    action: z.enum(["approve", "deny"]),
  })
  .strict();

async function handlePost(request: Request) {
  const session = await resolveSessionUser().catch(() => null);
  if (!session) {
    return desktopContractError(401, "SESSION_REQUIRED", false);
  }

  const { rawBody } = await readBoundedJsonBody(
    request,
    DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
  );
  const parsedBody = approvalRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return desktopContractError(400, "INVALID_DEVICE_SESSION_APPROVAL", false);
  }

  const userCode = parsedBody.data.userCode.toUpperCase();
  if (parsedBody.data.action === "approve") {
    const rejection = popEnforcementRejection(
      await evaluateDesktopManagedPopEnforcement({
        userId: session.user.id,
        clerkUserId: session.clerkUserId,
      }),
      session.user.organizationId
    );
    if (rejection) {
      return rejection;
    }
  }

  const row = await (parsedBody.data.action === "approve"
    ? desktopDeviceOnboardingService.approve({
        userCode,
        organizationId: session.user.organizationId,
        userId: session.user.id,
      })
    : desktopDeviceOnboardingService.deny({
        userCode,
        organizationId: session.user.organizationId,
        userId: session.user.id,
      })
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

export const POST = withRequestCompleted(handlePost);
