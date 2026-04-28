import { analytics } from "@repo/analytics/server";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  getDesktopApiNamespaceFromCapabilities,
  rewriteDesktopApiPath,
} from "@repo/api/src/desktop-api-namespace";
import type { ApiResult } from "@repo/api/src/types/common";
import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
} from "@repo/api/src/types/compute-target";
import { UPDATE_AND_RESTART_OPERATION_ID } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitCommandLifecycleEvent } from "@repo/observability/telemetry/emitter";
import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import {
  toRelayOperation,
  withCorrelationContext,
} from "../../relay-command-helpers";
import { computeTargetsService } from "../../service";
import { createDesktopCommandValidator } from "../../validators";

async function dispatchToRelay(
  relayApiUrl: string,
  internalSecret: string,
  targetId: string,
  commandId: string,
  relayOperation: ReturnType<typeof toRelayOperation>,
  requestId?: string
): Promise<boolean> {
  const wireCommand = toWireCommandFromRelayOperation(relayOperation);
  if (!wireCommand) {
    log.error("Failed to convert relay operation to wire command", {
      targetId,
      computeTargetId: targetId,
      commandId,
    });
    return false;
  }

  const correlatedCommand = withCorrelationContext(wireCommand, {
    requestId,
    computeTargetId: targetId,
  });
  const envelopedCommand = toEnvelope(correlatedCommand);
  try {
    const response = await fetch(`${relayApiUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({
        targetId,
        operation: envelopedCommand,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const result = await response.json().catch(() => ({ delivered: true }));
      log.info("Relay dispatch result", {
        targetId,
        computeTargetId: targetId,
        commandId,
        delivered: result.delivered,
        reason: result.reason,
      });
      return true;
    }
    const body = await response.text().catch(() => "");
    log.error("Relay dispatch failed", {
      targetId,
      computeTargetId: targetId,
      commandId,
      status: response.status,
      body,
    });
    return false;
  } catch (dispatchError) {
    log.error("Failed to dispatch command to relay", {
      targetId,
      computeTargetId: targetId,
      commandId,
      error: dispatchError,
    });
    return false;
  }
}

type DispatchContext = {
  traceContext: ReturnType<typeof buildTelemetryTraceContext>;
  pluginVersion: string | undefined;
  isUpdateAndRestart: boolean;
};

function emitDispatchedTelemetry(ctx: DispatchContext): void {
  emitCommandLifecycleEvent(
    TelemetryCategory.CommandDispatched,
    ctx.traceContext
  );
  if (ctx.isUpdateAndRestart) {
    emitCommandLifecycleEvent(
      TelemetryCategory.ElectronUpdateInitiated,
      ctx.traceContext,
      {
        message: `update-and-restart dispatched; fromVersion=${ctx.pluginVersion ?? "unknown"}`,
      }
    );
  }
}

/**
 * Checks whether the electron-remote-update feature flag is enabled for the given user.
 * Returns true when enabled or when PostHog is not configured (fail-open).
 */
async function isElectronRemoteUpdateEnabled(userId: string): Promise<boolean> {
  if (typeof analytics.isFeatureEnabled !== "function") {
    return true;
  }
  try {
    const result = await analytics.isFeatureEnabled(
      "electron-remote-update",
      userId
    );
    return result !== false;
  } catch {
    return true;
  }
}

/**
 * Validates all update-and-restart–specific preconditions:
 * operation supported by target, feature flag enabled, and no extra payload.
 * Returns a response if validation fails, or null if everything passes.
 */
async function checkUpdateAndRestartPreconditions(
  input: CreateDesktopCommandInput,
  supportedOperations: string[],
  userId: string
): Promise<NextResponse<ApiResult<never>> | null> {
  if (!supportedOperations.includes(UPDATE_AND_RESTART_OPERATION_ID)) {
    return NextResponse.json(
      { success: false, error: "Operation not supported by target" },
      { status: 422 }
    );
  }

  const allowed = await isElectronRemoteUpdateEnabled(userId);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: "Feature not available" },
      { status: 403 }
    );
  }

  if (
    input.body !== undefined ||
    (input.headers && Object.keys(input.headers).length > 0)
  ) {
    return NextResponse.json(
      {
        success: false,
        error: "update-and-restart does not accept a body or custom headers",
      },
      { status: 422 }
    );
  }

  return null;
}

/**
 * POST /compute-targets/:id/commands
 * Queues a desktop command and attempts immediate dispatch to active target transport.
 */
export const POST = withAnyAuth<
  CreateDesktopCommandResponse,
  "/compute-targets/[id]/commands"
>(async ({ user }, request, params) => {
  try {
    const { id: targetId } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      createDesktopCommandValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const target = await computeTargetsService.findOwnedById(
      targetId,
      user.organizationId,
      user.id
    );
    if (!target) {
      return notFoundResponse("Compute target");
    }

    const input = body as CreateDesktopCommandInput;

    if (input.operationId === UPDATE_AND_RESTART_OPERATION_ID) {
      const guardError = await checkUpdateAndRestartPreconditions(
        input,
        target.supportedOperations,
        user.id
      );
      if (guardError) {
        return guardError;
      }
    }

    const rewrittenInput: CreateDesktopCommandInput = {
      ...input,
      path: rewriteDesktopApiPath(
        input.path,
        getDesktopApiNamespaceFromCapabilities(target.capabilities) ??
          CURRENT_DESKTOP_API_NAMESPACE
      ),
    };
    const requestId = crypto.randomUUID();

    const createResult = await desktopCommandStore.createCommand(
      target.id,
      rewrittenInput,
      buildTelemetryTraceContext({
        computeTargetId: target.id,
        operationId: rewrittenInput.operationId,
        requestId,
      })
    );

    const { commandId } = createResult.command;

    const pluginVersionRaw = target.capabilities.pluginVersion;
    const pluginVersion =
      typeof pluginVersionRaw === "string" ? pluginVersionRaw : undefined;

    const traceContext = buildTelemetryTraceContext({
      commandId,
      operationId: rewrittenInput.operationId,
      computeTargetId: target.id,
      requestId,
      pluginVersion,
    });

    const relayOperation = toRelayOperation(commandId, rewrittenInput);

    const isUpdateAndRestart =
      input.operationId === UPDATE_AND_RESTART_OPERATION_ID;
    const dispatchCtx: DispatchContext = {
      traceContext,
      pluginVersion,
      isUpdateAndRestart,
    };

    // Dispatch via ECS relay when configured, otherwise use in-process relay bus
    const relayApiUrl = env.RELAY_API_URL;
    const internalSecret = env.INTERNAL_API_SECRET;
    if (relayApiUrl && internalSecret) {
      log.info("Dispatching command to relay", {
        relayApiUrl,
        targetId: target.id,
        computeTargetId: target.id,
        commandId,
        deduped: createResult.deduped,
      });
      const dispatched = await dispatchToRelay(
        relayApiUrl,
        internalSecret,
        target.id,
        commandId,
        relayOperation,
        requestId
      );
      if (dispatched) {
        emitDispatchedTelemetry(dispatchCtx);
      }
    } else {
      log.info("Using in-process relay bus (no RELAY_API_URL)", {
        targetId: target.id,
        computeTargetId: target.id,
        commandId,
      });
      relayEventBus.publishOperation(target.id, relayOperation);
      emitDispatchedTelemetry(dispatchCtx);
    }

    scheduleLogFlush();
    return successResponse({
      commandId,
      status: createResult.command.status,
      deduped: createResult.deduped ? true : undefined,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === desktopCommandStore.IdempotencyConflictError.name
    ) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 409 }
      );
    }
    return errorResponse("Failed to create desktop command", error);
  }
});
