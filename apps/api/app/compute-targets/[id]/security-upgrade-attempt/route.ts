import "server-only";

import type {
  DesktopSecurityUpgradeErrorBody,
  StartDesktopSecurityUpgradeResponse,
} from "@repo/api/src/types/compute-target";
import { DESKTOP_SECURITY_UPGRADE_OPERATION_ID } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { desktopOnboardingAttemptsService } from "@/app/desktop/onboarding-attempt/service";
import { env } from "@/env";
import { canonicalizeTrustedOrigin } from "@/lib/auth/canonical-trusted-origin";
import { resolveSessionUser } from "@/lib/auth/session-user";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  toRelayOperation,
  withCorrelationContext,
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

async function dispatchUpgradeCommand(
  targetId: string,
  commandId: string,
  relayOperation: ReturnType<typeof toRelayOperation>,
  requestId: string
): Promise<boolean> {
  const wireCommand = toWireCommandFromRelayOperation(relayOperation);
  if (!wireCommand) {
    return false;
  }

  const relayApiUrl = env.RELAY_API_URL;
  const internalSecret = env.INTERNAL_API_SECRET;
  if (!(relayApiUrl && internalSecret)) {
    relayEventBus.publishOperation(targetId, relayOperation);
    return true;
  }

  const operation = toEnvelope(
    withCorrelationContext(wireCommand, {
      requestId,
      computeTargetId: targetId,
    })
  );
  try {
    const response = await fetch(`${relayApiUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({ targetId, operation }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch (error) {
    log.warn("Desktop security-upgrade relay dispatch failed", {
      targetId,
      commandId,
      error,
    });
    return false;
  }
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
    target.security?.status !== "upgrade_available" ||
    !target.gatewayId ||
    !target.isOnline
  ) {
    return errorBody(409, {
      code: "TARGET_NOT_UPGRADEABLE",
      retryable: false,
    });
  }

  const attempt = await desktopOnboardingAttemptsService.create({
    organizationId: session.user.organizationId,
    userId: session.user.id,
    webAppOrigin,
    flowType: "compute_target_upgrade",
    computeTargetId: target.id,
    gatewayId: target.gatewayId,
  });

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
  const dispatched = await dispatchUpgradeCommand(
    target.id,
    commandId,
    toRelayOperation(commandId, commandInput),
    requestId
  );
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
