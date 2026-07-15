import { randomUUID } from "node:crypto";
import { analytics } from "@repo/analytics/server";
import { DESKTOP_AGENT_SESSIONS_SOCKET_EVENT } from "@repo/api/src/types/agent-session";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import {
  DesktopCommandStatus,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitConnectionStateEvent } from "@repo/observability/telemetry/emitter";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
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
import {
  computeTargetsService,
  isComputeTargetGatewayConflictResult,
} from "@/app/compute-targets/service";
import { githubDirtyScopeService } from "@/app/integrations/github/dirty-scope-service";
import { isAgentSessionSyncSupportedForUser } from "@/lib/agent-session-sync-feature";
import {
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import {
  type DesktopAnalyticsCaptureInput,
  handleDesktopAnalyticsEvent,
} from "@/lib/desktop-analytics-handler";
import { DESKTOP_ANALYTICS_SOCKET_EVENT } from "@/lib/desktop-analytics-schema";
import { acknowledgeDesktopCommand } from "@/lib/desktop-command-ack-handler";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { getRealDesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";
import {
  type DesktopHelloNackPayload,
  HELLO_OPERATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type WireCommandPayload,
} from "@/lib/desktop-gateway-types";
import {
  isTerminalEventData,
  parseCommandEventPayload,
  toEnvelope,
  toWireCommandFromStore,
} from "@/lib/desktop-gateway-wire";
import { publishLegacyRelayEvent } from "@/lib/desktop-relay-event-bridge";
import { buildDesktopServerCapabilities } from "@/lib/desktop-server-capabilities";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import { relayEventBus } from "@/lib/relay-event-bus";
import { isRecord } from "@/lib/type-guards";
import { runStage, timeStage } from "@/lib/with-timeout";

// ---------------------------------------------------------------------------
// Dispatch — routes an incoming socket event to the appropriate handler
// ---------------------------------------------------------------------------

function captureDesktopAnalytics(input: DesktopAnalyticsCaptureInput): void {
  analytics.capture(input);
}

export type SocketEventInput = {
  event: string;
  payload: unknown;
  auth: RelayAuthContext | null;
  targetId: string | undefined;
  correlation: Partial<CorrelationContext>;
  pluginVersion: string | undefined;
  relaySocketId: string | undefined;
  requestArrivedAt: number;
};

type RelayAuthContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the relay keeps a single centralized socket-event dispatcher by design
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
    relaySocketId,
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
        response: await handleCommandEvent(
          payload,
          targetId,
          correlation,
          auth
        ),
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

    case DESKTOP_ANALYTICS_SOCKET_EVENT:
      if (!(auth && targetId)) {
        return { ok: false, error: "Missing auth/targetId", status: 400 };
      }
      return {
        ok: true,
        response: {
          emit: [],
          ack: await handleDesktopAnalyticsEvent(
            payload,
            {
              organizationId: auth.organizationId,
              userId: auth.userId,
              clerkUserId: auth.clerkUserId,
              targetId,
              gatewaySessionId: correlation.gatewaySessionId,
              pluginVersion,
              relaySocketId,
            },
            {
              capture: captureDesktopAnalytics,
            }
          ),
        },
      };

    case DESKTOP_AGENT_SESSIONS_SOCKET_EVENT:
      if (!(auth && targetId)) {
        return { ok: false, error: "Missing auth/targetId", status: 400 };
      }
      return {
        ok: true,
        response: {
          emit: [],
          ack: await handleDesktopAgentSessionsEvent(payload, {
            organizationId: auth.organizationId,
            userId: auth.userId,
            clerkUserId: auth.clerkUserId,
            targetId,
            gatewaySessionId: correlation.gatewaySessionId,
            relaySocketId,
          }),
        },
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
      log.warn("relay.socket.unknown_event", {
        event,
        computeTargetId: targetId ?? correlation.computeTargetId ?? null,
        gatewaySessionIdHash: redactGatewaySessionId(
          correlation.gatewaySessionId
        ),
        requestId: correlation.requestId,
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
  ack?: unknown;
  disconnect?: boolean;
};

type DispatchResult =
  | { ok: true; response: SocketEventResponse }
  | { ok: false; error: string; status: number };

function wireCommand(command: WireCommandPayload): EmitInstruction {
  return { event: "desktop.command", payload: toEnvelope(command) };
}

type RelayHelloInput = {
  machineName: string;
  platform: string;
  capabilities: JsonObject;
  supportedOperations: string[];
  computeTargetId?: string;
  pluginVersion?: string;
  gatewayId?: string;
  desktopSecurityUpgradeProtocolVersion?: 1;
  maxInFlightCommands?: number;
};

function parseRelayHelloInput(payload: unknown): RelayHelloInput | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string"
  ) {
    return null;
  }

  const desktopSecurityUpgradeProtocolVersion =
    payload.desktopSecurityUpgradeProtocolVersion === 1 ? 1 : undefined;
  return {
    machineName: payload.machineName,
    platform: payload.platform,
    capabilities: {
      ...(isRecord(payload.capabilities)
        ? (payload.capabilities as JsonObject)
        : {}),
      maxInFlightCommands: (payload.maxInFlightCommands as JsonValue) ?? null,
      allowedDirectoriesHash:
        (payload.allowedDirectoriesHash as JsonValue) ?? null,
      socketProtocolVersion: PROTOCOL_VERSION,
      pluginVersion: (payload.pluginVersion as JsonValue) ?? null,
      desktopClientVersion: (payload.desktopClientVersion as JsonValue) ?? null,
      gatewayProtocolVersion:
        (payload.gatewayProtocolVersion as JsonValue) ?? null,
      desktopSecurityUpgradeProtocolVersion:
        desktopSecurityUpgradeProtocolVersion ?? null,
    },
    supportedOperations: Array.isArray(payload.supportedOperations)
      ? payload.supportedOperations.filter(
          (operation): operation is string => typeof operation === "string"
        )
      : [],
    computeTargetId:
      typeof payload.computeTargetId === "string"
        ? payload.computeTargetId
        : undefined,
    pluginVersion:
      typeof payload.pluginVersion === "string"
        ? payload.pluginVersion
        : undefined,
    gatewayId:
      typeof payload.gatewayId === "string" ? payload.gatewayId : undefined,
    desktopSecurityUpgradeProtocolVersion,
    maxInFlightCommands:
      typeof payload.maxInFlightCommands === "number"
        ? payload.maxInFlightCommands
        : undefined,
  };
}

type ResolveRelayHelloTargetResult =
  | {
      ok: true;
      targetId: string;
      targetCreated: boolean;
      targetGatewayId: string | null;
    }
  | { ok: false; reason: DesktopHelloNackReason; cause: unknown }
  | { ok: "conflict" };

async function resolveRelayHelloTarget(
  input: RelayHelloInput,
  auth: RelayAuthContext
): Promise<ResolveRelayHelloTargetResult> {
  if (input.computeTargetId) {
    const updateResult = await runStage(
      computeTargetsService.updateOwned(
        input.computeTargetId,
        auth.organizationId,
        auth.userId,
        {
          machineName: input.machineName,
          platform: input.platform,
          capabilities: input.capabilities,
          supportedOperations: input.supportedOperations,
          gatewayId: input.gatewayId,
          desktopSecurityUpgradeProtocolVersion:
            input.desktopSecurityUpgradeProtocolVersion,
        }
      ),
      HELLO_OPERATION_TIMEOUT_MS,
      "computeTargetsService.updateOwned",
      DesktopHelloNackReason.ComputeTargetUpdateFailed
    );
    if (!updateResult.ok) {
      return updateResult;
    }
    const updated = updateResult.value;
    if (isComputeTargetGatewayConflictResult(updated)) {
      return { ok: "conflict" };
    }
    if (updated.value) {
      return {
        ok: true,
        targetId: input.computeTargetId,
        targetCreated: false,
        targetGatewayId: updated.value.gatewayId ?? input.gatewayId ?? null,
      };
    }
  }

  const registerResult = await runStage(
    computeTargetsService.register(auth.organizationId, auth.userId, {
      machineName: input.machineName,
      platform: input.platform,
      capabilities: input.capabilities,
      supportedOperations: input.supportedOperations,
      pluginVersion: input.pluginVersion,
      gatewayId: input.gatewayId,
      desktopSecurityUpgradeProtocolVersion:
        input.desktopSecurityUpgradeProtocolVersion,
    }),
    HELLO_OPERATION_TIMEOUT_MS,
    "computeTargetsService.register",
    DesktopHelloNackReason.ComputeTargetRegisterFailed
  );
  if (!registerResult.ok) {
    return registerResult;
  }
  const target = registerResult.value;
  if (isComputeTargetGatewayConflictResult(target)) {
    return { ok: "conflict" };
  }
  return {
    ok: true,
    targetId: target.value.id,
    targetCreated: true,
    targetGatewayId: target.value.gatewayId ?? input.gatewayId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Event handlers — each returns what the relay should emit back to the worker
// ---------------------------------------------------------------------------

type HelloStageTimings = {
  resolveTargetMs?: number;
  pendingCommandsMs?: number;
  onlineStateMs?: number;
  featureFlagSigningMs?: number;
  featureFlagSyncMs?: number;
};

function logRelayHello(
  auth: RelayAuthContext,
  helloStart: number,
  stageTimings: HelloStageTimings,
  extra: Record<string, unknown>
): void {
  log.info("Relay hello processed", {
    organizationId: auth.organizationId,
    userId: auth.userId,
    timings: stageTimings,
    totalMs: Math.round(performance.now() - helloStart),
    ...extra,
  });
}

function helloNackResponse(
  reason: DesktopHelloNackReason
): SocketEventResponse {
  return {
    emit: [
      {
        event: "desktop.hello.nack",
        payload: toEnvelope<DesktopHelloNackPayload>({ reason }),
      },
    ],
    disconnect: true,
  };
}

async function handleHello(
  payload: unknown,
  auth: RelayAuthContext
): Promise<SocketEventResponse> {
  const helloStart = performance.now();
  const stageTimings: HelloStageTimings = {};

  const input = parseRelayHelloInput(payload);
  if (!input) {
    return { emit: [], disconnect: true };
  }

  const resolvedTarget = await timeStage(stageTimings, "resolveTargetMs", () =>
    resolveRelayHelloTarget(input, auth)
  );
  if (resolvedTarget.ok === false) {
    logRelayHello(auth, helloStart, stageTimings, { outcome: "nack" });
    return helloNackResponse(resolvedTarget.reason);
  }
  if (resolvedTarget.ok === "conflict") {
    log.warn("relay.hello.gateway_conflict", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      computeTargetId: input.computeTargetId,
      gatewayId: input.gatewayId,
      errorClass: ErrorClass.Protocol,
    });
    logRelayHello(auth, helloStart, stageTimings, {
      outcome: "gateway_conflict",
    });
    return { emit: [], disconnect: true };
  }
  const { targetId, targetCreated, targetGatewayId } = resolvedTarget;

  const [pendingCommandsResult, onlineStateResult, signingResult, syncResult] =
    await Promise.all([
      timeStage(stageTimings, "pendingCommandsMs", () =>
        runStage(
          desktopCommandStore.listNonTerminalDispatchCommands(targetId),
          HELLO_OPERATION_TIMEOUT_MS,
          "listNonTerminalDispatchCommands",
          DesktopHelloNackReason.PendingCommandsLookupFailed
        )
      ),
      timeStage(stageTimings, "onlineStateMs", () =>
        targetCreated
          ? Promise.resolve({ ok: true as const, value: true })
          : runStage(
              computeTargetsService.setOnlineState(
                targetId,
                auth.organizationId,
                auth.userId,
                true
              ),
              HELLO_OPERATION_TIMEOUT_MS,
              "setOnlineState",
              DesktopHelloNackReason.OnlineStateUpdateFailed
            )
      ),
      timeStage(stageTimings, "featureFlagSigningMs", () =>
        runStage(
          isComputeTargetSigningEligible({
            organizationId: auth.organizationId,
            userId: auth.userId,
            clerkUserId: auth.clerkUserId,
            gatewayId: targetGatewayId,
          }),
          HELLO_OPERATION_TIMEOUT_MS,
          "isComputeTargetSigningEligible",
          DesktopHelloNackReason.InternalError
        )
      ),
      timeStage(stageTimings, "featureFlagSyncMs", () =>
        runStage(
          isAgentSessionSyncSupportedForUser({
            userId: auth.userId,
            clerkUserId: auth.clerkUserId,
          }),
          HELLO_OPERATION_TIMEOUT_MS,
          "isAgentSessionSyncSupportedForUser",
          DesktopHelloNackReason.InternalError
        )
      ),
    ]);

  if (!pendingCommandsResult.ok) {
    logRelayHello(auth, helloStart, stageTimings, {
      computeTargetId: targetId,
      outcome: "nack",
    });
    return helloNackResponse(pendingCommandsResult.reason);
  }

  if (!onlineStateResult.ok) {
    logRelayHello(auth, helloStart, stageTimings, {
      computeTargetId: targetId,
      outcome: "nack",
    });
    return helloNackResponse(onlineStateResult.reason);
  }

  // Feature flags soft-fail to `false` — a slow or broken feature-flag SDK
  // must not prevent the hello handshake from completing.
  const commandSigningSupported =
    signingResult.ok &&
    signingResult.value.status === CommandSigningEligibilityStatus.Eligible;
  const agentSessionSyncSupported = syncResult.ok ? syncResult.value : false;
  const serverCapabilities = buildDesktopServerCapabilities({
    agentSessionSyncSupported,
    commandSigningSupported,
  });

  const pendingCommands = pendingCommandsResult.value;

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
      payload: toEnvelope({
        computeTargetId: targetId,
        sessionId,
        serverTime: new Date().toISOString(),
        ...(serverCapabilities ? { serverCapabilities } : {}),
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
      maxInFlightCommands: input.maxInFlightCommands,
    })
  );
  scheduleGitHubDirtyScopeRecoveryDrain({
    organizationId: auth.organizationId,
    targetId,
  });

  logRelayHello(auth, helloStart, stageTimings, {
    computeTargetId: targetId,
    gatewaySessionIdHash: redactGatewaySessionId(sessionId),
    outcome: "ack",
    targetCreated,
    pendingCommandCount: pendingCommands.length,
    serverCapabilities,
  });

  return { targetId, gatewaySessionId: sessionId, emit };
}

async function handleCommandEvent(
  payload: unknown,
  targetId: string,
  correlation: Partial<CorrelationContext>,
  auth: RelayAuthContext | null
): Promise<SocketEventResponse> {
  // Validate the full payload (commandId, sequence, eventType, and JSON-compatible
  // `data`) with the same schema the direct-socket handler uses. A blind
  // `payload.data as JsonValue` cast would let non-JSON values (undefined, BigInt,
  // functions, circular references) reach the command store and SSE subscribers,
  // risking serialization failures or downstream data corruption.
  const event = parseCommandEventPayload(payload);
  if (!event) {
    return { emit: [] };
  }

  const { commandId, eventType: rawEventType, data, sequence } = event;

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
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
    requestId: ctx.requestId,
  });

  const commandContext = getRealDesktopCommandTelemetryContext(ctx);
  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    eventType: rawEventType,
    data,
    sequence,
    computeTargetId: targetId,
    ...(commandContext ? { context: commandContext } : {}),
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
          payload: toEnvelope({ commandId, sequence: result.sequence }),
        },
      ],
    };
  }

  if (result.reason === "sequence_gap") {
    return await handleCommandSequenceGap({
      auth,
      commandId,
      ctx,
      sequence,
    });
  }

  return { emit: [] };
}

async function handleCommandSequenceGap(input: {
  auth: RelayAuthContext | null;
  commandId: string;
  ctx: TelemetryTraceContext;
  sequence: number;
}): Promise<SocketEventResponse> {
  const { auth, commandId, ctx, sequence } = input;
  log.warn("Relay command event sequence gap", {
    commandId,
    sequence,
    computeTargetId: ctx.computeTargetId,
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
    requestId: ctx.requestId,
    errorClass: ErrorClass.Protocol,
  });
  const command = await desktopCommandStore.getCommandById(commandId);
  if (!command) {
    return { emit: [] };
  }
  const serverCapabilities = await loadSequenceGapServerCapabilities(
    auth,
    command.computeTargetId
  );
  return {
    emit: [
      {
        event: "desktop.hello.ack",
        payload: toEnvelope({
          computeTargetId: command.computeTargetId,
          sessionId: randomUUID(),
          serverTime: new Date().toISOString(),
          ...(serverCapabilities ? { serverCapabilities } : {}),
          resumeFromSequence: {
            [commandId]: command.lastSequenceAcked,
          },
        }),
      },
    ],
  };
}

async function loadSequenceGapServerCapabilities(
  auth: RelayAuthContext | null,
  computeTargetId: string
): Promise<ComputeTargetServerCapabilities | undefined> {
  if (!auth) {
    return undefined;
  }
  const [targetResult, syncResult] = await Promise.all([
    runStage(
      computeTargetsService.findById(computeTargetId),
      HELLO_OPERATION_TIMEOUT_MS,
      "computeTargetsService.findById",
      DesktopHelloNackReason.InternalError
    ),
    runStage(
      isAgentSessionSyncSupportedForUser({
        userId: auth.userId,
        clerkUserId: auth.clerkUserId,
      }),
      HELLO_OPERATION_TIMEOUT_MS,
      "isAgentSessionSyncSupportedForUser",
      DesktopHelloNackReason.InternalError
    ),
  ]);
  const targetGatewayId = targetResult.ok
    ? targetResult.value?.gatewayId
    : null;
  const signingResult = targetGatewayId
    ? await runStage(
        isComputeTargetSigningEligible({
          organizationId: auth.organizationId,
          userId: auth.userId,
          clerkUserId: auth.clerkUserId,
          gatewayId: targetGatewayId,
        }),
        HELLO_OPERATION_TIMEOUT_MS,
        "isComputeTargetSigningEligible",
        DesktopHelloNackReason.InternalError
      )
    : null;
  return buildDesktopServerCapabilities({
    agentSessionSyncSupported: syncResult.ok ? syncResult.value : false,
    commandSigningSupported:
      signingResult?.ok === true &&
      signingResult.value.status === CommandSigningEligibilityStatus.Eligible,
  });
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
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
    requestId: ctx.requestId,
  });

  const commandContext = getRealDesktopCommandTelemetryContext(ctx);
  if (!commandContext) {
    log.info("command.ack.lifecycle_context_omitted", {
      commandId,
      computeTargetId: ctx.computeTargetId,
      gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
      requestId: ctx.requestId,
      reason: "missing_gateway_session",
    });
    emitProtocolMetric({
      metric: "command_ack_lifecycle_context_omitted",
      origin: ORIGIN,
      count: 1,
      computeTargetId: targetId,
      gatewaySessionId: ctx.gatewaySessionId,
    });
  }

  const acknowledged = await acknowledgeDesktopCommand({
    commandId,
    accepted,
    reason,
    targetId,
    ...(commandContext ? { context: commandContext } : {}),
  });

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
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
    requestId: ctx.requestId,
  });

  await computeTargetsService.heartbeat(
    auth.targetId,
    auth.organizationId,
    auth.userId
  );
  scheduleGitHubDirtyScopeRecoveryDrain({
    organizationId: auth.organizationId,
    targetId: auth.targetId,
  });

  emitProtocolMetric({
    metric: "presence_received_latency",
    origin: ORIGIN,
    value: Date.now() - requestArrivedAt,
    computeTargetId: auth.targetId,
    gatewaySessionId: ctx.gatewaySessionId,
  });

  return { emit: [] };
}

function scheduleGitHubDirtyScopeRecoveryDrain({
  organizationId,
  targetId,
}: {
  organizationId: string;
  targetId: string;
}): void {
  waitUntil(
    Promise.resolve()
      .then(() =>
        githubDirtyScopeService.dispatchDue({
          computeTargetId: targetId,
          organizationId,
        })
      )
      .catch((error) => {
        log.warn(
          "[relaySocketEvent] GitHub dirty-scope recovery drain failed",
          {
            computeTargetId: targetId,
            error,
            organizationId,
          }
        );
      })
  );
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
    gatewaySessionIdHash: redactGatewaySessionId(ctx.gatewaySessionId),
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
  auth: RelayAuthContext | null
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
    log.warn("fleet.capacity_metrics.query_failed", {
      computeTargetId: targetId,
      error,
    });
    return;
  }

  emitQueueMetric({
    metric: "queued_command_count",
    value: queuedCount,
    computeTargetId: targetId,
    origin: ORIGIN,
    filterToken: FilterToken.CommandQueued,
  });
  emitQueueMetric({
    metric: "in_flight_command_count",
    value: inFlightCount,
    computeTargetId: targetId,
    origin: ORIGIN,
    filterToken: FilterToken.CommandDispatched,
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
