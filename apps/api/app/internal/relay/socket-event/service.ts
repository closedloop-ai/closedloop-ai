import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitConnectionStateEvent } from "@repo/observability/telemetry/emitter";
import {
  emitProtocolMetric,
  emitQueueMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import type { TelemetryTraceContext } from "@repo/observability/telemetry/schema";
import {
  ErrorClass,
  TelemetryCategory,
} from "@repo/observability/telemetry/schema";
import { waitUntil } from "@vercel/functions";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  PROTOCOL_VERSION,
  type WireCommandPayload,
} from "@/lib/desktop-gateway-types";
import {
  isDesktopCommandEventType,
  isTerminalEventData,
  toWireCommandFromStore,
} from "@/lib/desktop-gateway-wire";
import { publishLegacyRelayEvent } from "@/lib/desktop-relay-event-bridge";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import { relayEventBus } from "@/lib/relay-event-bus";
import { isRecord } from "@/lib/type-guards";

// ---------------------------------------------------------------------------
// Dispatch — routes an incoming socket event to the appropriate handler
// ---------------------------------------------------------------------------

export type SocketEventInput = {
  event: string;
  payload: unknown;
  auth: { organizationId: string; userId: string } | null;
  targetId: string | undefined;
  correlation: Partial<CorrelationContext>;
  pluginVersion: string | undefined;
  requestArrivedAt: number;
};

export async function dispatchSocketEvent(
  input: SocketEventInput
): Promise<DispatchResult> {
  const {
    event,
    payload,
    auth,
    targetId,
    correlation,
    pluginVersion,
    requestArrivedAt,
  } = input;

  switch (event) {
    case "desktop.hello":
      if (!auth) {
        return { ok: false, error: "Missing auth context", status: 400 };
      }
      return { ok: true, response: await handleHello(payload, auth) };

    case "desktop.command.event":
      if (!targetId) {
        return { ok: false, error: "Missing targetId", status: 400 };
      }
      return {
        ok: true,
        response: await handleCommandEvent(payload, targetId, correlation),
      };

    case "desktop.command.ack":
      if (!targetId) {
        return { ok: false, error: "Missing targetId", status: 400 };
      }
      return {
        ok: true,
        response: await handleCommandAck(payload, targetId, correlation),
      };

    case "desktop.presence":
      if (!(auth && targetId)) {
        return { ok: false, error: "Missing auth/targetId", status: 400 };
      }
      return {
        ok: true,
        response: await handlePresence(
          { ...auth, targetId },
          correlation,
          requestArrivedAt
        ),
      };

    case "desktop.telemetry":
      if (!targetId) {
        return { ok: false, error: "Missing targetId", status: 400 };
      }
      return {
        ok: true,
        response: handleRelayTelemetry(
          payload,
          targetId,
          correlation,
          pluginVersion,
          auth
        ),
      };

    case "disconnect":
      if (!(auth && targetId)) {
        return { ok: false, error: "Missing auth/targetId", status: 400 };
      }
      return {
        ok: true,
        response: await handleDisconnect({ ...auth, targetId }, correlation),
      };

    default:
      log.warn("Unknown relay socket event", {
        event,
        errorClass: ErrorClass.Protocol,
      });
      return { ok: true, response: { emit: [] } };
  }
}

type CorrelationContext = Pick<
  TelemetryTraceContext,
  "commandId" | "computeTargetId" | "gatewaySessionId" | "requestId"
>;

type EmitInstruction = { event: string; payload: unknown };

type SocketEventResponse = {
  targetId?: string;
  gatewaySessionId?: string;
  emit: EmitInstruction[];
  disconnect?: boolean;
};

type DispatchResult =
  | { ok: true; response: SocketEventResponse }
  | { ok: false; error: string; status: number };

function envelope<T extends Record<string, unknown>>(
  payload: T
): T & {
  protocolVersion: string;
  messageId: string;
  timestamp: string;
} {
  return {
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

function wireCommand(command: WireCommandPayload): EmitInstruction {
  return { event: "desktop.command", payload: envelope(command) };
}

// ---------------------------------------------------------------------------
// Event handlers — each returns what the relay should emit back to the worker
// ---------------------------------------------------------------------------

async function handleHello(
  payload: unknown,
  auth: { organizationId: string; userId: string }
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [], disconnect: true };
  }

  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string"
  ) {
    return { emit: [], disconnect: true };
  }

  const machineName = payload.machineName;
  const platform = payload.platform;
  const capabilities: JsonObject = {
    ...(isRecord(payload.capabilities)
      ? (payload.capabilities as JsonObject)
      : {}),
    maxInFlightCommands: (payload.maxInFlightCommands as JsonValue) ?? null,
    allowedDirectoriesHash:
      (payload.allowedDirectoriesHash as JsonValue) ?? null,
    socketProtocolVersion: PROTOCOL_VERSION,
    pluginVersion: (payload.pluginVersion as JsonValue) ?? null,
  };
  const supportedOperations = Array.isArray(payload.supportedOperations)
    ? (payload.supportedOperations as string[])
    : [];

  let targetId = payload.computeTargetId as string | undefined;
  let targetCreated = false;

  if (targetId) {
    const updated = await computeTargetsService.updateOwned(
      targetId,
      auth.organizationId,
      auth.userId,
      { machineName, platform, capabilities, supportedOperations }
    );
    if (!updated) {
      targetId = undefined;
    }
  }

  if (!targetId) {
    const target = await computeTargetsService.register(
      auth.organizationId,
      auth.userId,
      {
        machineName,
        platform,
        capabilities,
        supportedOperations,
        pluginVersion:
          typeof payload.pluginVersion === "string"
            ? payload.pluginVersion
            : undefined,
      }
    );
    targetId = target.id;
    targetCreated = true;
  }

  const [pendingCommands] = await Promise.all([
    desktopCommandStore.listNonTerminalDispatchCommands(targetId),
    targetCreated
      ? Promise.resolve(true)
      : computeTargetsService.setOnlineState(
          targetId,
          auth.organizationId,
          auth.userId,
          true
        ),
  ]);

  // Clear stale in-process backlog so new dispatches go through clean
  relayEventBus.clearOperationBacklog(targetId);

  const sessionId = randomUUID();
  const resumeFromSequence = Object.fromEntries(
    pendingCommands.map((c) => [c.commandId, c.lastSequenceAcked])
  );

  const connectionCategory = targetCreated
    ? TelemetryCategory.ConnectionRegistered
    : TelemetryCategory.ConnectionResumed;

  emitConnectionStateEvent(
    connectionCategory,
    buildTelemetryTraceContext({
      computeTargetId: targetId,
      gatewaySessionId: sessionId,
    })
  );

  const emit: EmitInstruction[] = [
    {
      event: "desktop.hello.ack",
      payload: envelope({
        computeTargetId: targetId,
        sessionId,
        serverTime: new Date().toISOString(),
        ...(Object.keys(resumeFromSequence).length > 0
          ? { resumeFromSequence }
          : {}),
      }),
    },
  ];

  for (const command of pendingCommands) {
    emit.push(wireCommand(toWireCommandFromStore(command)));
  }

  waitUntil(
    emitFleetCapacityMetrics({
      targetId,
      maxInFlightCommands:
        typeof payload.maxInFlightCommands === "number"
          ? payload.maxInFlightCommands
          : undefined,
    })
  );

  return { targetId, gatewaySessionId: sessionId, emit };
}

async function handleCommandEvent(
  payload: unknown,
  targetId: string,
  correlation: Partial<CorrelationContext>
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [] };
  }

  if (
    typeof payload.commandId !== "string" ||
    typeof payload.sequence !== "number"
  ) {
    return { emit: [] };
  }

  const commandId = payload.commandId;
  const rawEventType = payload.eventType;
  const data = payload.data as JsonValue;
  const sequence = payload.sequence;

  if (!isDesktopCommandEventType(rawEventType)) {
    return { emit: [] };
  }

  const ctx = buildTelemetryTraceContext({
    ...correlation,
    commandId,
    computeTargetId: targetId,
  });

  log.info("Relay command event received", {
    commandId,
    eventType: rawEventType,
    sequence,
    computeTargetId: ctx.computeTargetId,
    gatewaySessionId: ctx.gatewaySessionId,
    requestId: ctx.requestId,
  });

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    eventType: rawEventType,
    data,
    sequence,
    computeTargetId: targetId,
  });

  if (result.accepted) {
    if (!result.duplicate) {
      // Publish to in-process event bus for live SSE subscribers on this Vercel instance
      await publishLegacyRelayEvent(commandId, {
        commandId,
        eventType: rawEventType,
        data,
        sequence,
      });

      const isTerminal =
        rawEventType === "done" ||
        (rawEventType === "error" && isTerminalEventData(data));
      if (isTerminal) {
        const command = await desktopCommandStore.getCommandById(commandId);
        if (command) {
          const latencyMs = Date.now() - new Date(command.createdAt).getTime();
          emitProtocolMetric({
            metric: "terminal_event_latency",
            origin: ORIGIN,
            value: latencyMs,
            computeTargetId: targetId,
            gatewaySessionId: ctx.gatewaySessionId,
          });
        }
      }
    }

    return {
      emit: [
        {
          event: "desktop.command.event.ack",
          payload: envelope({ commandId, sequence: result.sequence }),
        },
      ],
    };
  }

  if (result.reason === "sequence_gap") {
    log.warn("Relay command event sequence gap", {
      commandId,
      sequence,
      computeTargetId: ctx.computeTargetId,
      gatewaySessionId: ctx.gatewaySessionId,
      requestId: ctx.requestId,
      errorClass: ErrorClass.Protocol,
    });
    const command = await desktopCommandStore.getCommandById(commandId);
    if (command) {
      return {
        emit: [
          {
            event: "desktop.hello.ack",
            payload: envelope({
              computeTargetId: command.computeTargetId,
              sessionId: randomUUID(),
              serverTime: new Date().toISOString(),
              resumeFromSequence: {
                [commandId]: command.lastSequenceAcked,
              },
            }),
          },
        ],
      };
    }
  }

  return { emit: [] };
}

async function handleCommandAck(
  payload: unknown,
  targetId: string,
  correlation: Partial<CorrelationContext>
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [] };
  }

  if (
    typeof payload.commandId !== "string" ||
    typeof payload.accepted !== "boolean"
  ) {
    return { emit: [] };
  }

  const commandId = payload.commandId;
  const accepted = payload.accepted;
  const reason =
    typeof payload.reason === "string" ? payload.reason : undefined;

  const ctx = buildTelemetryTraceContext({
    ...correlation,
    commandId,
    computeTargetId: targetId,
  });

  log.info("Relay command ack received", {
    commandId,
    accepted,
    computeTargetId: ctx.computeTargetId,
    gatewaySessionId: ctx.gatewaySessionId,
    requestId: ctx.requestId,
  });

  const acknowledged = await desktopCommandStore.acknowledgeCommand(
    commandId,
    accepted,
    reason,
    targetId,
    ctx
  );

  if (acknowledged) {
    const latencyMs = Date.now() - new Date(acknowledged.createdAt).getTime();
    emitProtocolMetric({
      metric: "ack_latency",
      origin: ORIGIN,
      value: latencyMs,
      computeTargetId: targetId,
      gatewaySessionId: ctx.gatewaySessionId,
    });
  }

  // When Electron rejects a command (accepted=false), synthesize a terminal
  // error event so SSE subscribers (Chrome) stop waiting and see the failure.
  if (!accepted) {
    log.warn("Command rejected by desktop", {
      commandId,
      reason,
      computeTargetId: ctx.computeTargetId,
      gatewaySessionId: ctx.gatewaySessionId,
      requestId: ctx.requestId,
      errorClass: ErrorClass.Execution,
    });
    const errorData: JsonValue = {
      terminal: true,
      error: reason || "Command rejected by desktop",
      code: "rejected",
    } as unknown as JsonValue;
    const result = await desktopCommandStore.ingestCommandEvent({
      commandId,
      eventType: "error",
      data: errorData,
      computeTargetId: targetId,
    });
    if (result.accepted && !result.duplicate) {
      await publishLegacyRelayEvent(commandId, {
        commandId,
        eventType: "error",
        data: errorData,
        sequence: result.sequence,
      });
    }
  }

  return { emit: [] };
}

async function handlePresence(
  auth: {
    organizationId: string;
    userId: string;
    targetId: string;
  },
  correlation: Partial<CorrelationContext>,
  requestArrivedAt: number
): Promise<SocketEventResponse> {
  const ctx = buildTelemetryTraceContext({
    ...correlation,
    computeTargetId: auth.targetId,
  });

  log.info("Relay presence heartbeat", {
    computeTargetId: ctx.computeTargetId,
    gatewaySessionId: ctx.gatewaySessionId,
    requestId: ctx.requestId,
  });

  await computeTargetsService.heartbeat(
    auth.targetId,
    auth.organizationId,
    auth.userId
  );

  emitProtocolMetric({
    metric: "presence_received_latency",
    origin: ORIGIN,
    value: Date.now() - requestArrivedAt,
    computeTargetId: auth.targetId,
    gatewaySessionId: ctx.gatewaySessionId,
  });

  return { emit: [] };
}

async function handleDisconnect(
  auth: {
    organizationId: string;
    userId: string;
    targetId: string;
  },
  correlation: Partial<CorrelationContext>
): Promise<SocketEventResponse> {
  const ctx = buildTelemetryTraceContext({
    ...correlation,
    computeTargetId: auth.targetId,
  });

  log.info("Relay disconnect received", {
    computeTargetId: ctx.computeTargetId,
    gatewaySessionId: ctx.gatewaySessionId,
    requestId: ctx.requestId,
  });

  await computeTargetsService.setOnlineState(
    auth.targetId,
    auth.organizationId,
    auth.userId,
    false
  );

  emitConnectionStateEvent(
    TelemetryCategory.ConnectionDisconnected,
    buildTelemetryTraceContext({
      computeTargetId: ctx.computeTargetId,
      gatewaySessionId: ctx.gatewaySessionId,
      requestId: ctx.requestId,
    })
  );

  return { emit: [] };
}

function handleRelayTelemetry(
  payload: unknown,
  targetId: string,
  correlation: Partial<CorrelationContext>,
  pluginVersion: string | undefined,
  auth: { organizationId: string; userId: string } | null
): SocketEventResponse {
  const result = handleTelemetryEvent(payload, {
    authenticatedTargetId: targetId,
    pluginVersion,
    gatewaySessionId: correlation.gatewaySessionId,
    organizationId: auth?.organizationId,
    userId: auth?.userId,
  });

  if (!result.ok) {
    return { emit: result.emits };
  }

  return { emit: [] };
}

export async function emitFleetCapacityMetrics({
  targetId,
  maxInFlightCommands,
}: {
  targetId: string;
  maxInFlightCommands: number | undefined;
}): Promise<void> {
  let queuedCount: number;
  let inFlightCount: number;

  try {
    [queuedCount, inFlightCount] = await Promise.all([
      desktopCommandStore.countCommandsForTarget(
        targetId,
        DesktopCommandStatus.Queued
      ),
      desktopCommandStore.countCommandsForTarget(targetId, [
        DesktopCommandStatus.Accepted,
        DesktopCommandStatus.Running,
      ]),
    ]);
  } catch (error) {
    log.warn("fleet_capacity_metrics_query_failed", {
      event: "fleet_capacity_metrics_query_failed",
      computeTargetId: targetId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  emitQueueMetric({
    metric: "queued_command_count",
    value: queuedCount,
    computeTargetId: targetId,
    origin: ORIGIN,
  });
  emitQueueMetric({
    metric: "in_flight_command_count",
    value: inFlightCount,
    computeTargetId: targetId,
    origin: ORIGIN,
  });

  if (
    typeof maxInFlightCommands !== "number" ||
    maxInFlightCommands <= 0 ||
    !Number.isFinite(maxInFlightCommands)
  ) {
    log.warn("executor_saturation_skipped", {
      event: "executor_saturation_skipped",
      reason: "maxInFlightCommands_invalid",
      computeTargetId: targetId,
      maxInFlightCommands,
    });
    return;
  }

  // Intentionally unclamped: >1.0 signals overload (e.g. maxInFlightCommands lowered mid-flight).
  const value = inFlightCount / maxInFlightCommands;
  emitQueueMetric({
    metric: "executor_saturation",
    value,
    computeTargetId: targetId,
    origin: ORIGIN,
  });
}

export function extractCorrelationContext(
  body: Record<string, unknown>
): SocketEventInput["correlation"] {
  return {
    commandId: typeof body.commandId === "string" ? body.commandId : undefined,
    computeTargetId:
      typeof body.computeTargetId === "string"
        ? body.computeTargetId
        : undefined,
    gatewaySessionId:
      typeof body.gatewaySessionId === "string"
        ? body.gatewaySessionId
        : undefined,
    requestId: typeof body.requestId === "string" ? body.requestId : undefined,
  };
}
