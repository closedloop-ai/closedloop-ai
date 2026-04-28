import "server-only";

import type {
  DesktopSecurityUpgradeErrorBody,
  StartDesktopSecurityUpgradeResponse,
} from "@repo/api/src/types/compute-target";
import {
  DESKTOP_SECURITY_STATUS,
  DESKTOP_SECURITY_UPGRADE_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "../../relay-command-helpers";
import { computeTargetsService } from "../../service";

const upgradeRequestValidator = z
  .object({ webAppOrigin: z.string().trim().min(1).max(2048) })
  .strict();

function errorBody(
  status: number,
  body: DesktopSecurityUpgradeErrorBody
): NextResponse<DesktopSecurityUpgradeErrorBody> {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Creates a target-bound onboarding attempt and dispatches the local Desktop
 * security-upgrade command. The command body carries no API key material.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await resolveSessionUser().catch(() => null);
  if (!session) {
    return errorBody(401, { code: "SESSION_REQUIRED", retryable: false });
  }

  const { id: targetId } = await params;
  const rawBody = await request.json().catch(() => null);
  const parsedBody = upgradeRequestValidator.safeParse(rawBody);
  if (!parsedBody.success) {
    return errorBody(422, {
      code: "TARGET_NOT_UPGRADEABLE",
      retryable: false,
    });
  }

  const webAppOrigin = canonicalizeTrustedOrigin(parsedBody.data.webAppOrigin);
  if (!webAppOrigin) {
    return errorBody(422, {
      code: "TARGET_NOT_UPGRADEABLE",
      retryable: false,
    });
  }

  const target = await computeTargetsService.findOwnedById(
    targetId,
    session.user.organizationId,
    session.user.id,
    session.clerkUserId
  );
  if (!target) {
    return errorBody(404, { code: "TARGET_NOT_FOUND", retryable: false });
  }
  if (
    target.security?.status !== DESKTOP_SECURITY_STATUS.UpgradeAvailable ||
    !target.gatewayId ||
    !target.isOnline
  ) {
    return errorBody(409, {
      code: "TARGET_NOT_UPGRADEABLE",
      retryable: false,
    });
  }

  const attempt = await desktopOnboardingAttemptsService
    .create({
      organizationId: session.user.organizationId,
      userId: session.user.id,
      webAppOrigin,
      flowType: "compute_target_upgrade",
      computeTargetId: target.id,
      gatewayId: target.gatewayId,
    })
    .catch((error) => {
      log.warn("Desktop security-upgrade attempt creation failed", {
        targetId: target.id,
        error,
      });
      return null;
    });
  if (!attempt) {
    return errorBody(503, {
      code: "UPGRADE_ATTEMPT_CREATE_FAILED",
      retryable: true,
    });
  }

  const commandBody = {
    onboardingAttemptId: attempt.onboardingAttemptId,
    webAppOrigin,
    computeTargetId: target.id,
    gatewayId: target.gatewayId,
    expiresAt: attempt.expiresAt.toISOString(),
  };
  const requestId = crypto.randomUUID();
  const commandInput = {
    operationId: DESKTOP_SECURITY_UPGRADE_OPERATION_ID,
    method: "POST" as const,
    path: "/api/gateway/security/upgrade",
    body: commandBody,
    timeoutMs: 10 * 60 * 1000,
    idempotencyKey: `security-upgrade:${target.id}:${attempt.onboardingAttemptId}`,
  };
  const createResult = await desktopCommandStore.createCommand(
    target.id,
    commandInput,
    buildTelemetryTraceContext({
      computeTargetId: target.id,
      operationId: commandInput.operationId,
      requestId,
    })
  );
  const commandId = createResult.command.commandId;
  const dispatched = await dispatchRelayCommandToRelay({
    targetId: target.id,
    commandId,
    relayOperation: toRelayOperation(commandId, commandInput),
    requestId,
  });
  if (!dispatched) {
    await desktopCommandStore.markCommandExpired(
      commandId,
      "Security upgrade command dispatch failed"
    );
    return errorBody(503, {
      code: "UPGRADE_COMMAND_DISPATCH_FAILED",
      retryable: true,
    });
  }

  return NextResponse.json(
    {
      commandId,
      expiresAt: attempt.expiresAt.toISOString(),
    } satisfies StartDesktopSecurityUpgradeResponse,
    { headers: { "Cache-Control": "no-store" } }
  );
}
