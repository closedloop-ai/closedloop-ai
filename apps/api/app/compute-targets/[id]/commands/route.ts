import type {
  CreateDesktopCommandInput,
  CreateDesktopCommandResponse,
} from "@repo/api/src/types/compute-target";
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
        commandId,
        delivered: result.delivered,
        reason: result.reason,
      });
      return true;
    }
    const body = await response.text().catch(() => "");
    log.error("Relay dispatch failed", {
      targetId,
      commandId,
      status: response.status,
      body,
    });
    return false;
  } catch (dispatchError) {
    log.error("Failed to dispatch command to relay", {
      targetId,
      commandId,
      error: dispatchError,
    });
    return false;
  }
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
    const requestId = crypto.randomUUID();

    const createResult = await desktopCommandStore.createCommand(
      target.id,
      input,
      buildTelemetryTraceContext({
        computeTargetId: target.id,
        operationId: input.operationId,
        requestId,
      })
    );

    const { commandId } = createResult.command;
    const traceContext = buildTelemetryTraceContext({
      commandId,
      operationId: input.operationId,
      computeTargetId: target.id,
      requestId,
    });

    const relayOperation = toRelayOperation(commandId, input);

    // Dispatch via ECS relay when configured, otherwise use in-process relay bus
    const relayApiUrl = env.RELAY_API_URL;
    const internalSecret = env.INTERNAL_API_SECRET;
    if (relayApiUrl && internalSecret) {
      log.info("Dispatching command to relay", {
        relayApiUrl,
        targetId: target.id,
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
        emitCommandLifecycleEvent(
          TelemetryCategory.CommandDispatched,
          traceContext
        );
      }
    } else {
      log.info("Using in-process relay bus (no RELAY_API_URL)", {
        targetId: target.id,
        commandId,
      });
      relayEventBus.publishOperation(target.id, relayOperation);
      emitCommandLifecycleEvent(
        TelemetryCategory.CommandDispatched,
        traceContext
      );
    }

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
