import { randomUUID } from "node:crypto";
import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import {
  DESKTOP_HELLO_ACK_SOCKET_EVENT,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitConnectionStateEvent } from "@repo/observability/telemetry/emitter";
import { emitProtocolMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import type { TelemetryTraceContext } from "@repo/observability/telemetry/schema";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { waitUntil } from "@vercel/functions";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  CommandSigningEligibilityStatus,
  isComputeTargetSigningEligible,
} from "@/lib/compute-target-signing-eligibility";
import { isTerminalDesktopCommandStatus } from "@/lib/desktop-command-mappers";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { getRealDesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";
import { HELLO_OPERATION_TIMEOUT_MS } from "@/lib/desktop-gateway-types";
import {
  isTerminalEventData,
  parseCommandEventPayload,
  toEnvelope,
} from "@/lib/desktop-gateway-wire";
import { buildDesktopServerCapabilities } from "@/lib/desktop-server-capabilities";
import { isRecord } from "@/lib/type-guards";
import { runStage } from "@/lib/with-timeout";
import { handleCommandAck } from "./service/command-ack";
import { scheduleQueuedCommandRelease } from "./service/command-drain";
import { emitPresenceFleetCapacityMetrics } from "./service/fleet-capacity-sampler";
import { scheduleGitHubDirtyScopeRecoveryDrain } from "./service/github-dirty-scope-drain";
import { handleHello } from "./service/hello-handler";
import type {
  CorrelationContext,
  RelayAuthContext,
  SocketEventResponse,
} from "./service/types";

// ---------------------------------------------------------------------------
// Dispatch — routes an incoming socket event to the appropriate handler
// ---------------------------------------------------------------------------

export type SocketEventInput = {
  event: string;
  payload: unknown;
  auth: RelayAuthContext | null;
  targetId: string | undefined;
  correlation: Partial<CorrelationContext>;
  requestArrivedAt: number;
};

type DispatchResult =
  | { ok: true; response: SocketEventResponse }
  | { ok: false; error: string; status: number };

export async function dispatchSocketEvent(
  input: SocketEventInput
): Promise<DispatchResult> {
  const { event, payload, auth, targetId, correlation, requestArrivedAt } =
    input;

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
          requestArrivedAt,
          payload
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

// ---------------------------------------------------------------------------
// Event handlers — each returns what the relay should emit back to the worker
// ---------------------------------------------------------------------------

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
      // The store's own verdict, not a second opinion: `resolveCommandUpdate`
      // also retires a `result` event carrying `terminal: true`, which the
      // event-type check below does not name. A slot freed by one of those is
      // still a slot.
      if (
        result.nextStatus &&
        isTerminalDesktopCommandStatus(result.nextStatus)
      ) {
        scheduleQueuedCommandRelease(targetId);
      }

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
        event: DESKTOP_HELLO_ACK_SOCKET_EVENT,
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
  const targetResult = await runStage(
    computeTargetsService.findById(computeTargetId),
    HELLO_OPERATION_TIMEOUT_MS,
    "computeTargetsService.findById",
    DesktopHelloNackReason.InternalError
  );
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
    commandSigningSupported:
      signingResult?.ok === true &&
      signingResult.value.status === CommandSigningEligibilityStatus.Eligible,
  });
}

/**
 * The desktop's own executor occupancy, off the presence payload, returned RAW.
 *
 * JSON carries no `undefined`, so `undefined` here means the field was absent —
 * the older-client omission, which degrades to no saturation sample. Every other
 * value is handed on unvalidated so `emitFleetCapacityMetrics` can tell a
 * malformed one apart from that omission and warn on it. Narrowing to `number`
 * here folded the two together: `activeCommands: "2"` reported itself as an
 * absent field at debug level and the invalid-payload signal never fired.
 */
function readActiveCommands(payload: unknown): unknown {
  return isRecord(payload) ? payload.activeCommands : undefined;
}

async function handlePresence(
  auth: {
    organizationId: string;
    userId: string;
    targetId: string;
  },
  correlation: Partial<CorrelationContext>,
  requestArrivedAt: number,
  payload: unknown
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

  // ISS-8897: `recordRelayPresence`, not `heartbeat`. This is the one path that
  // drives `emitPresenceFleetCapacityMetrics` below, and therefore the one path
  // whose timestamp the idle drain may read as "the presence trigger owns this
  // target's backlog". Every other check-in stamps `lastSeenAt` alone.
  await computeTargetsService.recordRelayPresence(
    auth.targetId,
    auth.organizationId,
    auth.userId
  );
  scheduleGitHubDirtyScopeRecoveryDrain({
    organizationId: auth.organizationId,
    targetId: auth.targetId,
  });
  waitUntil(
    emitPresenceFleetCapacityMetrics(auth.targetId, readActiveCommands(payload))
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
