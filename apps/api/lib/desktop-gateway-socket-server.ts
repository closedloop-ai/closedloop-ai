import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandEventType } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { Server, type Socket } from "socket.io";
import { apiKeysService } from "../app/api-keys/service";
import { computeTargetsService } from "../app/compute-targets/service";
import { usersService } from "../app/users/service";
import { desktopCommandStore } from "./desktop-command-store";
import { relayEventBus } from "./relay-event-bus";

const SOCKET_NAMESPACE = "/desktop-gateway";
const PROTOCOL_VERSION = "1";
const SOCKET_HEARTBEAT_INTERVAL_MS = 30_000;

type DesktopAuthContext = {
  organizationId: string;
  userId: string;
};

type DesktopHelloPayload = {
  computeTargetId?: string;
  machineName: string;
  platform: string;
  pluginVersion: string;
  supportedOperations: string[];
  maxInFlightCommands: number;
  allowedDirectoriesHash?: string;
  capabilities?: Record<string, unknown>;
};

type SocketConnectionContext = {
  targetId: string;
  organizationId: string;
  userId: string;
  sessionId: string;
  unsubscribeOperations: () => void;
  unsubscribeConnectionClose: () => void;
  heartbeatTimer: ReturnType<typeof setInterval>;
};

type WireCommandPayload = {
  commandId: string;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  queuedAt?: string;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
};

type Envelope<T> = T & {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  timestamp: string;
};

type DesktopCommandAckPayload = {
  commandId: string;
  accepted: boolean;
  reason?: string;
};

type DesktopCommandEventPayload = {
  commandId: string;
  sequence: number;
  eventType: DesktopCommandEventType;
  data: JsonValue;
};

type DesktopGatewaySocketServer = {
  io: Server;
  close: () => Promise<void>;
};

type GatewaySocketData = {
  authContext?: DesktopAuthContext;
  authDurationMs?: number;
  connectStartedAt?: number;
};

const serverInstances = new WeakMap<HttpServer, DesktopGatewaySocketServer>();
const contextsBySocketId = new Map<string, SocketConnectionContext>();
const socketIdsByTargetId = new Map<string, Set<string>>();
const helloInFlight = new Set<string>();

import { isRecord } from "@/lib/type-guards";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function toEnvelope<T extends Record<string, unknown>>(
  payload: T
): Envelope<T> {
  return {
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
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

function parseHelloPayload(payload: unknown): DesktopHelloPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string" ||
    typeof payload.pluginVersion !== "string" ||
    !isStringArray(payload.supportedOperations) ||
    typeof payload.maxInFlightCommands !== "number" ||
    payload.maxInFlightCommands < 1
  ) {
    return null;
  }

  return {
    computeTargetId:
      typeof payload.computeTargetId === "string"
        ? payload.computeTargetId
        : undefined,
    machineName: payload.machineName,
    platform: payload.platform,
    pluginVersion: payload.pluginVersion,
    supportedOperations: payload.supportedOperations,
    maxInFlightCommands: Math.floor(payload.maxInFlightCommands),
    allowedDirectoriesHash:
      typeof payload.allowedDirectoriesHash === "string"
        ? payload.allowedDirectoriesHash
        : undefined,
    capabilities: isRecord(payload.capabilities)
      ? payload.capabilities
      : undefined,
  };
}

function normalizeMethod(value: unknown): WireCommandPayload["method"] | null {
  if (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  ) {
    return value;
  }
  return null;
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function splitPathAndQuery(pathWithQuery: string): {
  path: string;
  query?: Record<string, string | string[]>;
} {
  const url = new URL(pathWithQuery, "http://desktop-gateway.local");
  const groupedQuery = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const values = groupedQuery.get(key) ?? [];
    values.push(value);
    groupedQuery.set(key, values);
  }

  if (groupedQuery.size === 0) {
    return { path: url.pathname };
  }

  return {
    path: url.pathname,
    query: Object.fromEntries(
      Array.from(groupedQuery.entries()).map(([key, values]) => [
        key,
        values.length === 1 ? values[0] : values,
      ])
    ),
  };
}

function toWireCommandFromStore(command: {
  commandId: string;
  operationId: string;
  method: WireCommandPayload["method"];
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: JsonValue;
  timeoutMs?: number;
  lockKey?: string;
  requiresApproval?: boolean;
  approvalReason?: string;
  createdAt: string;
}): WireCommandPayload {
  return {
    commandId: command.commandId,
    operationId: command.operationId,
    method: command.method,
    path: command.path,
    headers: command.headers,
    query: command.query,
    body: command.body,
    timeoutMs: command.timeoutMs,
    queuedAt: command.createdAt,
    lockKey: command.lockKey,
    requiresApproval: command.requiresApproval,
    approvalReason: command.approvalReason,
  };
}

function toWireCommandFromRelayOperation(operation: {
  operationId: string;
  params: JsonValue;
}): WireCommandPayload | null {
  const params = isRecord(operation.params) ? operation.params : {};
  const request = isRecord(params.request) ? params.request : {};
  const rawPath = typeof request.path === "string" ? request.path : null;
  const method = normalizeMethod(request.method);
  const commandId =
    typeof params.commandId === "string" ? params.commandId : null;

  if (!(rawPath && method && commandId)) {
    return null;
  }

  const { path, query } = splitPathAndQuery(rawPath);
  if (!path.startsWith("/api/engineer/")) {
    return null;
  }

  return {
    commandId,
    operationId: operation.operationId,
    method,
    path,
    headers: toStringRecord(request.headers),
    query,
    body: ("body" in request ? (request.body as JsonValue) : null) as JsonValue,
    timeoutMs:
      typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
    lockKey: typeof params.lockKey === "string" ? params.lockKey : undefined,
    requiresApproval:
      typeof params.requiresApproval === "boolean"
        ? params.requiresApproval
        : undefined,
    approvalReason:
      typeof params.approvalReason === "string"
        ? params.approvalReason
        : undefined,
  };
}

function emitCommand(socket: Socket, command: WireCommandPayload): void {
  socket.emit("desktop.command", toEnvelope(command));
}

function parseCommandAckPayload(
  payload: unknown
): DesktopCommandAckPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.commandId !== "string" ||
    typeof payload.accepted !== "boolean"
  ) {
    return null;
  }
  return {
    commandId: payload.commandId,
    accepted: payload.accepted,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
  };
}

function isDesktopCommandEventType(
  value: unknown
): value is DesktopCommandEventType {
  return (
    value === "status" ||
    value === "chunk" ||
    value === "result" ||
    value === "error" ||
    value === "done"
  );
}

function parseCommandEventPayload(
  payload: unknown
): DesktopCommandEventPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.commandId !== "string" ||
    typeof payload.sequence !== "number" ||
    payload.sequence < 1 ||
    !Number.isInteger(payload.sequence) ||
    !isDesktopCommandEventType(payload.eventType)
  ) {
    return null;
  }
  return {
    commandId: payload.commandId,
    sequence: payload.sequence,
    eventType: payload.eventType,
    data: (payload.data as JsonValue | undefined) ?? null,
  };
}

function isTerminalEventData(data: JsonValue): boolean {
  return isRecord(data) && data.terminal === true;
}

async function publishLegacyRelayEvent(
  commandId: string,
  event: DesktopCommandEventPayload
): Promise<void> {
  const command = await desktopCommandStore.getCommandById(commandId);
  if (!command) {
    return;
  }

  if (event.eventType === "result" && isTerminalEventData(event.data)) {
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      result: event.data,
      done: true,
      sequence: event.sequence,
    });
    return;
  }

  if (event.eventType === "done") {
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      event: event.data,
      done: true,
      sequence: event.sequence,
    });
    return;
  }

  if (event.eventType === "error") {
    const error =
      isRecord(event.data) && typeof event.data.error === "string"
        ? event.data.error
        : "Command failed";
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      event: event.data,
      done: isTerminalEventData(event.data),
      error,
      sequence: event.sequence,
    });
    return;
  }

  relayEventBus.publishResult(command.operationId, {
    operationId: command.operationId,
    event: event.data,
    done: false,
    sequence: event.sequence,
  });
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
  payload: DesktopHelloPayload,
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

    desktopCommandStore
      .acknowledgeCommand(
        payload.commandId,
        payload.accepted,
        payload.reason,
        context.targetId
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

    desktopCommandStore
      .ingestCommandEvent({
        commandId: payload.commandId,
        eventType: payload.eventType,
        data: payload.data,
        sequence: payload.sequence,
        computeTargetId: context.targetId,
      })
      .then(async (result) => {
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
      })
      .catch((error) => {
        log.error("Failed handling desktop.command.event", {
          socketId: socket.id,
          commandId: payload.commandId,
          error,
        });
      });
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
