import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { Server, type Socket } from "socket.io";
import { apiKeysService } from "../app/api-keys/service";
import { computeTargetsService } from "../app/compute-targets/service";
import { usersService } from "../app/users/service";
import { desktopCommandStore } from "./desktop-command-store";
import {
  type DesktopAuthContext,
  type DesktopGatewaySocketServer,
  type GatewaySocketData,
  PROTOCOL_VERSION,
  type SocketConnectionContext,
} from "./desktop-gateway-types";
import {
  emitCommand,
  parseCommandAckPayload,
  parseCommandEventPayload,
  parseHelloPayload,
  toEnvelope,
  toWireCommandFromRelayOperation,
  toWireCommandFromStore,
} from "./desktop-gateway-wire";
import { publishLegacyRelayEvent } from "./desktop-relay-event-bridge";
import { handleTelemetryEvent } from "./desktop-telemetry-handler";
import { relayEventBus } from "./relay-event-bus";

const SOCKET_NAMESPACE = "/desktop-gateway";
const SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;

const serverInstances = new WeakMap<HttpServer, DesktopGatewaySocketServer>();
const contextsBySocketId = new Map<string, SocketConnectionContext>();
const socketIdsByTargetId = new Map<string, Set<string>>();
const helloInFlight = new Set<string>();

/**
 * Per-command promise chain to serialize event ingestion.
 * Without this, rapid socket events for the same command trigger concurrent
 * DB transactions that race on `lastSequenceAcked`, causing sequence_gap
 * rejections and expensive retry loops (O(n²) for n events).
 */
const eventIngestionChains = new Map<string, Promise<void>>();

function enqueueEventIngestion(
  commandId: string,
  fn: () => Promise<void>
): void {
  const previous = eventIngestionChains.get(commandId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  eventIngestionChains.set(commandId, next);
  // Clean up the chain entry when it settles to avoid memory leaks
  next.then(() => {
    if (eventIngestionChains.get(commandId) === next) {
      eventIngestionChains.delete(commandId);
    }
  });
}

function getSocketData(socket: Socket): GatewaySocketData {
  return socket.data as GatewaySocketData;
}

function extractApiKey(socket: Socket): string | null {
  let authToken: string | null = null;
  if (typeof socket.handshake.auth?.token === "string") {
    authToken = socket.handshake.auth.token;
  } else if (typeof socket.handshake.auth?.apiKey === "string") {
    authToken = socket.handshake.auth.apiKey;
  }

  const authHeader = socket.handshake.headers.authorization;
  const headerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

  const token = authToken ?? headerToken;
  if (!token?.startsWith("sk_live_")) {
    return null;
  }
  return token;
}

// Inlined API key auth — cannot import resolveApiKeyTokenContext because
// resolve-any-auth-context.ts transitively pulls in clerk-service → server-only
// which throws when running outside Next.js (the custom socket server via tsx).
async function resolveDesktopAuthContext(
  socket: Socket
): Promise<DesktopAuthContext | null> {
  const apiKey = extractApiKey(socket);
  if (!apiKey) {
    return null;
  }

  const keyContext = await apiKeysService.verifyKey(apiKey);
  if (!keyContext) {
    return null;
  }

  if (!keyContext.scopes.includes("write")) {
    return null;
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return null;
  }

  return {
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
  };
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

async function handleSocketHello(
  socket: Socket,
  authContext: DesktopAuthContext,
  payload: ReturnType<typeof parseHelloPayload> & object,
  timing: {
    connectStartedAt?: number;
    authDurationMs?: number;
    helloStartedAt: number;
  }
): Promise<void> {
  const mergedCapabilities = {
    ...(payload.capabilities ?? {}),
    maxInFlightCommands: payload.maxInFlightCommands,
    allowedDirectoriesHash: payload.allowedDirectoriesHash ?? null,
    socketProtocolVersion: PROTOCOL_VERSION,
    pluginVersion: payload.pluginVersion,
  };

  let targetId = payload.computeTargetId;
  let targetCreated = false;
  if (targetId) {
    const updated = await computeTargetsService.updateOwned(
      targetId,
      authContext.organizationId,
      authContext.userId,
      {
        machineName: payload.machineName,
        platform: payload.platform,
        capabilities: mergedCapabilities,
        supportedOperations: payload.supportedOperations,
      }
    );
    if (!updated) {
      targetId = undefined;
    }
  }

  if (!targetId) {
    const target = await computeTargetsService.register(
      authContext.organizationId,
      authContext.userId,
      {
        machineName: payload.machineName,
        platform: payload.platform,
        capabilities: mergedCapabilities,
        supportedOperations: payload.supportedOperations,
        pluginVersion: payload.pluginVersion,
      }
    );
    targetId = target.id;
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
    (operation) => {
      const wireCommand = toWireCommandFromRelayOperation(operation);
      if (!wireCommand) {
        return;
      }
      emitCommand(socket, wireCommand);
    }
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
    pluginVersion: payload.pluginVersion,
    unsubscribeOperations,
    unsubscribeConnectionClose,
    heartbeatTimer,
  });

  const socketIds = socketIdsByTargetId.get(targetId) ?? new Set<string>();
  socketIds.add(socket.id);
  socketIdsByTargetId.set(targetId, socketIds);

  const pendingCommandsPromise =
    desktopCommandStore.listNonTerminalDispatchCommands(targetId);
  const onlineUpdatePromise = targetCreated
    ? Promise.resolve(true)
    : computeTargetsService.setOnlineState(
        targetId,
        authContext.organizationId,
        authContext.userId,
        true
      );
  const [pendingCommands, onlineUpdated] = await Promise.all([
    pendingCommandsPromise,
    onlineUpdatePromise,
  ]);

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
          { socketId: socket.id, targetId, error }
        );
      });
    log.info(
      "Desktop gateway hello cancelled — socket disconnected mid-hello",
      {
        socketId: socket.id,
        targetId,
      }
    );
    return;
  }

  if (!onlineUpdated) {
    log.warn("Desktop target online-state update missed during hello", {
      socketId: socket.id,
      targetId,
      organizationId: authContext.organizationId,
      userId: authContext.userId,
    });
  }

  const resumeFromSequence = Object.fromEntries(
    pendingCommands.map((command) => [
      command.commandId,
      command.lastSequenceAcked,
    ])
  );

  const ackSentAt = Date.now();
  socket.emit(
    "desktop.hello.ack",
    toEnvelope({
      computeTargetId: targetId,
      sessionId,
      serverTime: new Date().toISOString(),
      ...(Object.keys(resumeFromSequence).length > 0
        ? { resumeFromSequence }
        : {}),
    })
  );

  for (const command of pendingCommands) {
    emitCommand(socket, toWireCommandFromStore(command));
  }

  log.info("Desktop gateway hello acknowledged", {
    socketId: socket.id,
    targetId,
    organizationId: authContext.organizationId,
    userId: authContext.userId,
    authDurationMs: timing.authDurationMs,
    helloProcessingMs: ackSentAt - timing.helloStartedAt,
    connectToHelloAckMs: timing.connectStartedAt
      ? ackSentAt - timing.connectStartedAt
      : undefined,
    pendingCommandCount: pendingCommands.length,
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

function handleSocketConnection(socket: Socket): void {
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
    });

    desktopCommandStore
      .acknowledgeCommand(
        payload.commandId,
        payload.accepted,
        payload.reason,
        context.targetId,
        ackCtx
      )
      .catch((error) => {
        log.error("Failed handling desktop.command.ack", {
          socketId: socket.id,
          commandId: payload.commandId,
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

    enqueueEventIngestion(payload.commandId, async () => {
      try {
        const result = await desktopCommandStore.ingestCommandEvent({
          commandId: payload.commandId,
          eventType: payload.eventType,
          data: payload.data,
          sequence: payload.sequence,
          computeTargetId: context.targetId,
        });

        if (result.accepted) {
          socket.emit(
            "desktop.command.event.ack",
            toEnvelope({
              commandId: payload.commandId,
              sequence: result.sequence,
            })
          );
          if (!result.duplicate) {
            await publishLegacyRelayEvent(payload.commandId, payload);
          }
          return;
        }

        if (result.reason === "sequence_gap") {
          const command = await desktopCommandStore.getCommandById(
            payload.commandId
          );
          if (command) {
            socket.emit(
              "desktop.hello.ack",
              toEnvelope({
                computeTargetId: command.computeTargetId,
                sessionId:
                  contextsBySocketId.get(socket.id)?.sessionId ?? randomUUID(),
                serverTime: new Date().toISOString(),
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
          error,
        });
      }
    });
  });

  socket.on("desktop.telemetry", (rawPayload: unknown) => {
    const context = contextsBySocketId.get(socket.id);
    if (!context) {
      return;
    }

    try {
      const result = handleTelemetryEvent(rawPayload, {
        authenticatedTargetId: context.targetId,
        pluginVersion: context.pluginVersion,
        gatewaySessionId: context.sessionId,
      });
      if (!result.ok) {
        for (const emit of result.emits) {
          socket.emit(emit.event, emit.payload);
        }
      }
    } catch (error) {
      log.error("Failed handling desktop.telemetry", {
        socketId: socket.id,
        targetId: context.targetId,
        error,
      });
    }
  });

  socket.on("disconnect", () => {
    handleSocketDisconnect(socket.id).catch((error) => {
      log.error("Failed handling desktop socket disconnect", {
        socketId: socket.id,
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
    maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for large loop artifacts
    cors: {
      origin: true,
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
