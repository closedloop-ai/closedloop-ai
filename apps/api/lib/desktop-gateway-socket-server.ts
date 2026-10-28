import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import {
  DESKTOP_HELLO_ACK_SOCKET_EVENT,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { Server, type Socket } from "socket.io";
import {
  computeTargetsService,
  isComputeTargetGatewayConflictResult,
} from "../app/compute-targets/service";
import {
  CommandSigningEligibilityStatus,
  isDirectDesktopAuthSigningEligible,
} from "./compute-target-signing-eligibility";
import { acknowledgeDesktopCommand } from "./desktop-command-ack-handler";
import { enqueueEventIngestion } from "./desktop-command-event-chain";
import { desktopCommandStore } from "./desktop-command-store";
import { getRealDesktopCommandTelemetryContext } from "./desktop-command-telemetry-context";
import { refuseUnboundedHelloFields } from "./desktop-gateway-hello-field-guard";
import { emitPendingCommandsForReconnect } from "./desktop-gateway-reconnect";
import { resolveDesktopAuthContext } from "./desktop-gateway-socket-auth";
import {
  type DesktopAuthContext,
  type DesktopGatewaySocketServer,
  type DesktopHelloNackPayload,
  type GatewaySocketData,
  HELLO_OPERATION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SOCKET_HEARTBEAT_INTERVAL_MS,
  type SocketConnectionContext,
} from "./desktop-gateway-types";
import {
  DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES,
  emitCommand,
  handleRelayOperationForSocket,
  parseCommandAckPayload,
  parseCommandEventPayload,
  parseHelloPayload,
  toEnvelope,
  toWireCommandFromStore,
} from "./desktop-gateway-wire";
import { statedMintingOrigin } from "./desktop-hello-ack-minting-origin";
import { buildDesktopServerCapabilities } from "./desktop-server-capabilities";
import { relayEventBus } from "./relay-event-bus";
import { isTrustedOrigin } from "./trusted-origins";
import {
  isTimeoutError,
  runStage,
  timeStage,
  withTimeout,
} from "./with-timeout";

const SOCKET_NAMESPACE = "/desktop-gateway";

const serverInstances = new WeakMap<HttpServer, DesktopGatewaySocketServer>();
const contextsBySocketId = new Map<string, SocketConnectionContext>();
const socketIdsByTargetId = new Map<string, Set<string>>();
const helloInFlight = new Set<string>();

type CommandEventPayload = NonNullable<
  ReturnType<typeof parseCommandEventPayload>
>;

async function ingestDesktopCommandEventForSocket(input: {
  socket: Socket;
  context: SocketConnectionContext;
  payload: CommandEventPayload;
}): Promise<void> {
  const { socket, context, payload } = input;
  try {
    const eventCtx = buildTelemetryTraceContext({
      gatewaySessionId: context.sessionId,
      computeTargetId: context.targetId,
      commandId: payload.commandId,
    });
    const commandContext = getRealDesktopCommandTelemetryContext(eventCtx);
    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: payload.commandId,
      eventType: payload.eventType,
      data: payload.data,
      sequence: payload.sequence,
      computeTargetId: context.targetId,
      ...(commandContext ? { context: commandContext } : {}),
    });

    if (result.accepted) {
      socket.emit(
        "desktop.command.event.ack",
        toEnvelope({
          commandId: payload.commandId,
          sequence: result.sequence,
        })
      );
      return;
    }

    if (result.reason === "sequence_gap") {
      const command = await desktopCommandStore.getCommandById(
        payload.commandId
      );
      if (command) {
        socket.emit(
          DESKTOP_HELLO_ACK_SOCKET_EVENT,
          toEnvelope({
            computeTargetId: command.computeTargetId,
            sessionId:
              contextsBySocketId.get(socket.id)?.sessionId ?? randomUUID(),
            serverTime: new Date().toISOString(),
            ...statedMintingOrigin(),
            ...(context.serverCapabilities
              ? { serverCapabilities: context.serverCapabilities }
              : {}),
            resumeFromSequence: {
              [payload.commandId]: command.lastSequenceAcked,
            },
          })
        );
      }
    }
  } catch (error) {
    log.error("Failed handling desktop.command.event", {
      socketId: socket.id,
      commandId: payload.commandId,
      computeTargetId: context.targetId,
      gatewaySessionIdHash: redactGatewaySessionId(context.sessionId),
      error,
    });
  }
}

function getSocketData(socket: Socket): GatewaySocketData {
  return socket.data as GatewaySocketData;
}

function removeSocketFromTarget(targetId: string, socketId: string): boolean {
  const socketIds = socketIdsByTargetId.get(targetId);
  if (!socketIds) {
    return false;
  }
  socketIds.delete(socketId);
  if (socketIds.size === 0) {
    socketIdsByTargetId.delete(targetId);
    return true;
  }
  return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the socket hello flow intentionally owns target registration, resubscription, and handshake ack emission
export async function handleSocketHello(
  socket: Socket,
  authContext: DesktopAuthContext,
  payload: ReturnType<typeof parseHelloPayload> & object,
  timing: {
    connectStartedAt?: number;
    authDurationMs?: number;
    helloStartedAt: number;
  }
): Promise<void> {
  if (!refuseUnboundedHelloFields(socket, payload)) {
    return;
  }

  const mergedCapabilities = {
    ...(payload.capabilities ?? {}),
    maxInFlightCommands: payload.maxInFlightCommands,
    allowedDirectoriesHash: payload.allowedDirectoriesHash ?? null,
    socketProtocolVersion: PROTOCOL_VERSION,
    pluginVersion: payload.pluginVersion,
    desktopClientVersion: payload.desktopClientVersion ?? null,
    gatewayProtocolVersion: payload.gatewayProtocolVersion ?? null,
    desktopSecurityUpgradeProtocolVersion:
      payload.desktopSecurityUpgradeProtocolVersion ?? null,
  };

  const stageTimings: {
    updateOwnedMs?: number;
    registerMs?: number;
    pendingCommandsMs?: number;
    onlineStateMs?: number;
    featureFlagSigningMs?: number;
    ackEmitMs?: number;
  } = {};

  let targetId = payload.computeTargetId;
  let targetCreated = false;
  if (targetId) {
    const existingTargetId = targetId;
    let updated: Awaited<ReturnType<typeof computeTargetsService.updateOwned>>;
    try {
      updated = await timeStage(stageTimings, "updateOwnedMs", () =>
        withTimeout(
          computeTargetsService.updateOwned(
            existingTargetId,
            authContext.organizationId,
            authContext.userId,
            {
              machineName: payload.machineName,
              platform: payload.platform,
              capabilities: mergedCapabilities,
              supportedOperations: payload.supportedOperations,
              gatewayId: payload.gatewayId ?? null,
              desktopSecurityUpgradeProtocolVersion:
                payload.desktopSecurityUpgradeProtocolVersion,
            }
          ),
          HELLO_OPERATION_TIMEOUT_MS,
          "computeTargetsService.updateOwned"
        )
      );
    } catch (error) {
      const errorKind = isTimeoutError(
        error,
        "computeTargetsService.updateOwned"
      )
        ? "timeout"
        : "failure";
      log.error("desktop.gateway.hello.update_failed", {
        socketId: socket.id,
        targetId,
        computeTargetId: targetId,
        errorKind,
        detail: `Compute target update ${errorKind === "timeout" ? "timed out" : "failed"}`,
        error,
      });
      socket.emit(
        "desktop.hello.nack",
        toEnvelope<DesktopHelloNackPayload>({
          reason: DesktopHelloNackReason.ComputeTargetUpdateFailed,
        })
      );
      socket.disconnect(true);
      return;
    }
    if (isComputeTargetGatewayConflictResult(updated)) {
      socket.disconnect(true);
      return;
    }
    if (!updated.value) {
      targetId = undefined;
    }
  }

  if (!targetId) {
    let target: Awaited<ReturnType<typeof computeTargetsService.register>>;
    try {
      target = await timeStage(stageTimings, "registerMs", () =>
        withTimeout(
          computeTargetsService.register(
            authContext.organizationId,
            authContext.userId,
            {
              machineName: payload.machineName,
              platform: payload.platform,
              capabilities: mergedCapabilities,
              supportedOperations: payload.supportedOperations,
              pluginVersion: payload.pluginVersion,
              gatewayId: payload.gatewayId ?? null,
              desktopSecurityUpgradeProtocolVersion:
                payload.desktopSecurityUpgradeProtocolVersion,
            }
          ),
          HELLO_OPERATION_TIMEOUT_MS,
          "computeTargetsService.register"
        )
      );
    } catch (error) {
      const errorKind = isTimeoutError(error, "computeTargetsService.register")
        ? "timeout"
        : "failure";
      log.error("desktop.gateway.hello.register_failed", {
        socketId: socket.id,
        errorKind,
        error,
      });
      socket.emit(
        "desktop.hello.nack",
        toEnvelope<DesktopHelloNackPayload>({
          reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
        })
      );
      socket.disconnect(true);
      return;
    }
    if (isComputeTargetGatewayConflictResult(target)) {
      socket.disconnect(true);
      return;
    }
    targetId = target.value.id;
    targetCreated = true;
  }

  const existingContext = contextsBySocketId.get(socket.id);
  if (existingContext) {
    existingContext.unsubscribeOperations();
    existingContext.unsubscribeConnectionClose();
    clearInterval(existingContext.heartbeatTimer);
    removeSocketFromTarget(existingContext.targetId, socket.id);
  }

  const sessionId = randomUUID();
  // Clear stale backlog before subscribing — the DB query below is the
  // authoritative source for pending commands.  Without this, subscribe
  // replays the backlog *and* we emit from the DB, causing duplicates.
  relayEventBus.clearOperationBacklog(targetId);
  const unsubscribeOperations = relayEventBus.subscribeOperations(
    targetId,
    (operation) => handleRelayOperationForSocket(socket, operation, targetId)
  );
  const unsubscribeConnectionClose = relayEventBus.subscribeTargetConnection(
    targetId,
    () => {
      socket.disconnect(true);
    }
  );
  const heartbeatTimer = setInterval(() => {
    computeTargetsService
      .heartbeat(targetId, authContext.organizationId, authContext.userId)
      .catch((error) => {
        log.error("Failed socket heartbeat refresh for desktop target", {
          socketId: socket.id,
          targetId,
          computeTargetId: targetId,
          gatewaySessionIdHash: redactGatewaySessionId(sessionId),
          organizationId: authContext.organizationId,
          userId: authContext.userId,
          error,
        });
      });
  }, SOCKET_HEARTBEAT_INTERVAL_MS);

  contextsBySocketId.set(socket.id, {
    targetId,
    organizationId: authContext.organizationId,
    userId: authContext.userId,
    sessionId,
    unsubscribeOperations,
    unsubscribeConnectionClose,
    heartbeatTimer,
  });

  const socketIds = socketIdsByTargetId.get(targetId) ?? new Set<string>();
  socketIds.add(socket.id);
  socketIdsByTargetId.set(targetId, socketIds);

  // Run all three post-target-resolution stages concurrently. Each stage
  // returns a typed result so per-stage nack reasons (and the timeout-vs-
  // failure distinction) are preserved without try/catch fan-out. Mirrors
  // the relay-path parallelism in `service.ts`.
  const [pendingCommandsResult, onlineStateResult, signingResult] =
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
                authContext.organizationId,
                authContext.userId,
                true
              ),
              HELLO_OPERATION_TIMEOUT_MS,
              "setOnlineState",
              DesktopHelloNackReason.OnlineStateUpdateFailed
            )
      ),
      timeStage(stageTimings, "featureFlagSigningMs", () =>
        runStage(
          isDirectDesktopAuthSigningEligible({
            organizationId: authContext.organizationId,
            userId: authContext.userId,
            clerkUserId: authContext.clerkUserId,
            apiKeySource: authContext.apiKeySource,
            apiKeyGatewayId: authContext.apiKeyGatewayId,
            apiKeyBoundPublicKey: authContext.apiKeyBoundPublicKey,
            targetGatewayId: payload.gatewayId ?? authContext.apiKeyGatewayId,
          }),
          HELLO_OPERATION_TIMEOUT_MS,
          "isDirectDesktopAuthSigningEligible",
          DesktopHelloNackReason.InternalError
        )
      ),
    ]);

  if (!pendingCommandsResult.ok) {
    const errorKind = isTimeoutError(
      pendingCommandsResult.cause,
      "listNonTerminalDispatchCommands"
    )
      ? "timeout"
      : "failure";
    log.error("desktop.gateway.hello.pending_commands_failed", {
      socketId: socket.id,
      targetId,
      computeTargetId: targetId,
      errorKind,
      detail: `Pending commands lookup ${errorKind === "timeout" ? "timed out" : "failed"}`,
      error: pendingCommandsResult.cause,
    });
    socket.emit(
      "desktop.hello.nack",
      toEnvelope<DesktopHelloNackPayload>({
        reason: pendingCommandsResult.reason,
      })
    );
    socket.disconnect(true);
    return;
  }
  const pendingCommands = pendingCommandsResult.value;

  if (!onlineStateResult.ok) {
    const errorKind = isTimeoutError(onlineStateResult.cause, "setOnlineState")
      ? "timeout"
      : "failure";
    log.error("desktop.gateway.hello.online_state_failed", {
      socketId: socket.id,
      targetId,
      computeTargetId: targetId,
      errorKind,
      detail: `Online state update ${errorKind === "timeout" ? "timed out" : "failed"}`,
      error: onlineStateResult.cause,
    });
    socket.emit(
      "desktop.hello.nack",
      toEnvelope<DesktopHelloNackPayload>({
        reason: onlineStateResult.reason,
      })
    );
    socket.disconnect(true);
    return;
  }
  const onlineUpdated = onlineStateResult.value;

  // The signing feature flag soft-fails to `false` so a slow or broken
  // feature-flag SDK cannot prevent the hello handshake from completing.
  const commandSigningSupported =
    signingResult.ok &&
    signingResult.value.status === CommandSigningEligibilityStatus.Eligible;
  const serverCapabilities = buildDesktopServerCapabilities({
    commandSigningSupported,
  });

  // Guard: if the socket disconnected during the async work above,
  // compensate by marking the target offline and cleaning up resources.
  // The disconnect handler may have already run (before contextsBySocketId
  // was set, or after), so all cleanup operations here are idempotent.
  if (!socket.connected) {
    unsubscribeOperations();
    unsubscribeConnectionClose();
    clearInterval(heartbeatTimer);
    contextsBySocketId.delete(socket.id);
    removeSocketFromTarget(targetId, socket.id);
    computeTargetsService
      .setOnlineState(
        targetId,
        authContext.organizationId,
        authContext.userId,
        false
      )
      .catch((error) => {
        log.error(
          "Failed to compensate online state after disconnect during hello",
          {
            socketId: socket.id,
            targetId,
            computeTargetId: targetId,
            gatewaySessionIdHash: redactGatewaySessionId(sessionId),
            error,
          }
        );
      });
    log.info(
      "Desktop gateway hello cancelled — socket disconnected mid-hello",
      {
        socketId: socket.id,
        targetId,
        computeTargetId: targetId,
      }
    );
    return;
  }

  if (!onlineUpdated) {
    log.warn("Desktop target online-state update missed during hello", {
      socketId: socket.id,
      targetId,
      computeTargetId: targetId,
      organizationId: authContext.organizationId,
      userId: authContext.userId,
    });
  }
  const context = contextsBySocketId.get(socket.id);
  if (context) {
    context.serverCapabilities = serverCapabilities;
  }

  const resumeFromSequence = Object.fromEntries(
    pendingCommands.map((command) => [
      command.commandId,
      command.lastSequenceAcked,
    ])
  );

  const ackSentAt = Date.now();
  const ackEmitStart = performance.now();
  socket.emit(
    DESKTOP_HELLO_ACK_SOCKET_EVENT,
    toEnvelope({
      computeTargetId: targetId,
      sessionId,
      serverTime: new Date().toISOString(),
      ...statedMintingOrigin(),
      ...(serverCapabilities ? { serverCapabilities } : {}),
      ...(Object.keys(resumeFromSequence).length > 0
        ? { resumeFromSequence }
        : {}),
    })
  );
  stageTimings.ackEmitMs = Math.round(performance.now() - ackEmitStart);

  emitPendingCommandsForReconnect(pendingCommands, (command) => {
    emitCommand(socket, toWireCommandFromStore(command));
  });

  log.info("desktop.gateway.hello.acknowledged", {
    socketId: socket.id,
    targetId,
    computeTargetId: targetId,
    organizationId: authContext.organizationId,
    userId: authContext.userId,
    declaredGatewayId: payload.gatewayId ?? null,
    authDurationMs: timing.authDurationMs,
    helloProcessingMs: ackSentAt - timing.helloStartedAt,
    connectToHelloAckMs: timing.connectStartedAt
      ? ackSentAt - timing.connectStartedAt
      : undefined,
    pendingCommandCount: pendingCommands.length,
    serverCapabilities,
    timings: stageTimings,
  });
}

async function handleSocketDisconnect(socketId: string): Promise<void> {
  helloInFlight.delete(socketId);
  const context = contextsBySocketId.get(socketId);
  if (!context) {
    return;
  }

  contextsBySocketId.delete(socketId);
  context.unsubscribeOperations();
  context.unsubscribeConnectionClose();
  clearInterval(context.heartbeatTimer);

  const lastSocketForTarget = removeSocketFromTarget(
    context.targetId,
    socketId
  );
  if (lastSocketForTarget) {
    await computeTargetsService.setOnlineState(
      context.targetId,
      context.organizationId,
      context.userId,
      false
    );
  }
}

export function handleSocketConnection(socket: Socket): void {
  const authContext = getSocketData(socket).authContext;
  if (!authContext) {
    log.warn("Desktop gateway socket missing auth context after middleware", {
      socketId: socket.id,
    });
    socket.disconnect(true);
    return;
  }

  socket.on("desktop.hello", (rawPayload: unknown) => {
    if (helloInFlight.has(socket.id)) {
      return;
    }

    const helloStartedAt = Date.now();
    const payload = parseHelloPayload(rawPayload);
    if (!payload) {
      socket.disconnect(true);
      return;
    }

    helloInFlight.add(socket.id);
    const socketData = getSocketData(socket);
    handleSocketHello(socket, authContext, payload, {
      connectStartedAt: socketData.connectStartedAt,
      authDurationMs: socketData.authDurationMs,
      helloStartedAt,
    })
      .catch((error) => {
        log.error(
          "Failed processing desktop.hello after authenticated connect",
          {
            socketId: socket.id,
            computeTargetId: payload.computeTargetId ?? null,
            organizationId: authContext.organizationId,
            userId: authContext.userId,
            helloProcessingMs: Date.now() - helloStartedAt,
            authDurationMs: socketData.authDurationMs,
            connectToHelloFailureMs: socketData.connectStartedAt
              ? Date.now() - socketData.connectStartedAt
              : undefined,
            error,
          }
        );
        socket.disconnect(true);
      })
      .finally(() => {
        helloInFlight.delete(socket.id);
      });
  });

  socket.on("desktop.presence", () => {
    const context = contextsBySocketId.get(socket.id);
    if (!context) {
      return;
    }
    computeTargetsService
      .heartbeat(context.targetId, context.organizationId, context.userId)
      .catch((error) => {
        log.error("Failed updating desktop presence heartbeat", {
          socketId: socket.id,
          targetId: context.targetId,
          computeTargetId: context.targetId,
          error,
        });
      });
  });

  socket.on("desktop.command.ack", (rawPayload: unknown) => {
    const context = contextsBySocketId.get(socket.id);
    if (!context) {
      return;
    }
    const payload = parseCommandAckPayload(rawPayload);
    if (!payload) {
      return;
    }

    const ackCtx = buildTelemetryTraceContext({
      gatewaySessionId: context.sessionId,
      computeTargetId: context.targetId,
      commandId: payload.commandId,
    });
    const commandContext = getRealDesktopCommandTelemetryContext(ackCtx);

    acknowledgeDesktopCommand({
      commandId: payload.commandId,
      accepted: payload.accepted,
      reason: payload.reason,
      targetId: context.targetId,
      ...(commandContext ? { context: commandContext } : {}),
    }).catch((error) => {
      log.error("Failed handling desktop.command.ack", {
        socketId: socket.id,
        commandId: payload.commandId,
        computeTargetId: context.targetId,
        gatewaySessionIdHash: redactGatewaySessionId(context.sessionId),
        error,
      });
    });
  });

  socket.on("desktop.command.event", (rawPayload: unknown) => {
    const context = contextsBySocketId.get(socket.id);
    if (!context) {
      return;
    }
    const payload = parseCommandEventPayload(rawPayload);
    if (!payload) {
      return;
    }

    enqueueEventIngestion(payload.commandId, () =>
      ingestDesktopCommandEventForSocket({ socket, context, payload })
    );
  });

  socket.on("disconnect", () => {
    // Capture the session id before handleSocketDisconnect deletes the context.
    const capturedSessionId = contextsBySocketId.get(socket.id)?.sessionId;
    handleSocketDisconnect(socket.id).catch((error) => {
      log.error("Failed handling desktop socket disconnect", {
        socketId: socket.id,
        gatewaySessionIdHash: redactGatewaySessionId(capturedSessionId),
        error,
      });
    });
  });
}

export function initDesktopGatewaySocketServer(
  httpServer: HttpServer
): DesktopGatewaySocketServer {
  const existing = serverInstances.get(httpServer);
  if (existing) {
    return existing;
  }

  const io = new Server(httpServer, {
    transports: ["websocket"],
    maxHttpBufferSize: DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES,
    cors: {
      // Desktop gateway workers connect via Node socket.io-client and send no
      // browser Origin header — allow those. Any request that does carry an
      // Origin is a browser and must match the HTTP API's trusted-origin
      // allowlist, so a future transport broadening (e.g. re-adding HTTP
      // long-polling) cannot expose this credentialed namespace to arbitrary
      // sites.
      origin: (origin, callback) =>
        callback(null, !origin || isTrustedOrigin(origin)),
      credentials: true,
    },
  });

  const namespace = io.of(SOCKET_NAMESPACE);
  namespace.use((socket, next) => {
    const startedAt = Date.now();
    const socketData = getSocketData(socket);
    socketData.connectStartedAt = startedAt;

    resolveDesktopAuthContext(socket)
      .then((authContext) => {
        const authDurationMs = Date.now() - startedAt;
        if (!authContext) {
          log.warn("Desktop gateway socket auth rejected", {
            socketId: socket.id,
            authDurationMs,
          });
          next(new Error("Unauthorized"));
          return;
        }

        socketData.authContext = authContext;
        socketData.authDurationMs = authDurationMs;
        log.info("Desktop gateway socket auth accepted", {
          socketId: socket.id,
          organizationId: authContext.organizationId,
          userId: authContext.userId,
          authDurationMs,
        });
        next();
      })
      .catch((error) => {
        log.error("Desktop gateway socket auth failed", {
          socketId: socket.id,
          authDurationMs: Date.now() - startedAt,
          error,
        });
        next(new Error("Unauthorized"));
      });
  });

  namespace.on("connection", (socket) => {
    try {
      handleSocketConnection(socket);
    } catch (error) {
      log.error("Failed initializing desktop socket connection", {
        socketId: socket.id,
        error,
      });
      socket.disconnect(true);
    }
  });

  const instance: DesktopGatewaySocketServer = {
    io,
    close: () =>
      new Promise((resolve, reject) => {
        io.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };

  serverInstances.set(httpServer, instance);
  return instance;
}
