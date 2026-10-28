import { EventEmitter } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { DESKTOP_POP_HEADER_NAMES } from "@repo/api/src/types/api-key";
import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { flushLogsWithDeadline } from "@repo/observability/shutdown";
import {
  ConnectionState,
  emitProtocolMetric,
  type ProtocolMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { createRedisClient } from "@repo/redis";
import type { Socket } from "socket.io";
import { handleDispatch } from "./dispatch-handler.js";
import {
  attachEngineConnectionErrorLogging,
  attachHttpServerErrorLogging,
  attachSocketErrorLogging,
} from "./error-listeners.js";
import {
  jsonResponse,
  parseRequestUrl,
  respondInternalError,
} from "./http-io.js";
import { resolveInstanceId, resolvePrivateIp } from "./instance-discovery.js";
import { registerKeylessTelemetryNamespace } from "./keyless-otlp-ingress.js";
import { parseOptionalBoundedEnvInt, parsePositiveEnvMs } from "./parse-env.js";
import { handleInternalDispatch } from "./peer-dispatch.js";
import {
  heartbeatPresencePayload,
  registerPresenceHandler,
} from "./presence-forward.js";
import {
  INTERNAL_API_SECRET,
  RELAY_PORT,
  VERCEL_API_URL,
} from "./relay-env.js";
import { emitHelloInternalErrorNack, emitSocketEvents } from "./socket-emit.js";
import { createSocketServer } from "./socket-server.js";
import {
  InMemoryTargetRegistry,
  RedisTargetRegistry,
  type TargetMetadata,
  type TargetRegistry,
} from "./target-registry.js";
import { type DesktopPopHeaders, forwardSocketEvent } from "./vercel-client.js";
import {
  startWorkerHeartbeat,
  type WorkerContext,
} from "./worker-heartbeat.js";
import {
  cleanupOldWorker,
  disposeWorkerTimers,
  drainPendingBuffer,
  pushPendingBuffer,
  socketToTarget,
  workersByTargetId,
} from "./worker-registry.js";

if (!Number.isInteger(RELAY_PORT) || RELAY_PORT < 1 || RELAY_PORT > 65_535) {
  log.error("Invalid RELAY_PORT");
  process.exit(1);
}
const HEARTBEAT_DEGRADED_THRESHOLD_MS = parsePositiveEnvMs(
  "HEARTBEAT_DEGRADED_THRESHOLD_MS",
  RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS * 2
);
const RELAY_RUNTIME_MODE = process.env.RELAY_RUNTIME_MODE ?? "inmemory";

let targetRegistry: TargetRegistry = new InMemoryTargetRegistry();
let relayInstanceId = "unknown";
let ownerGeneration = 0;
let instanceKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

if (!INTERNAL_API_SECRET) {
  log.error("INTERNAL_API_SECRET is required");
  process.exit(1);
}

if (!VERCEL_API_URL) {
  log.error("CLOSEDLOOP_API_URL is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-memory state — only socket mappings, no business data
// ---------------------------------------------------------------------------

function safeEmitConnectionStateCount(
  metric: Extract<ProtocolMetric, { metric: "connection_state_count" }>
): void {
  try {
    emitProtocolMetric(metric);
  } catch (error) {
    log.warn("ConnectionStateCountEmitFailed", {
      targetId: metric.computeTargetId,
      state: metric.state,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function emitConnectionState(
  state: ConnectionState,
  targetId: string,
  gatewaySessionId: string | null | undefined
): void {
  safeEmitConnectionStateCount({
    metric: "connection_state_count",
    state,
    count: 1,
    computeTargetId: targetId,
    gatewaySessionId: gatewaySessionId ?? undefined,
    timestamp: new Date().toISOString(),
  });
}

function extractDesktopPopHeaders(
  headers: IncomingHttpHeaders
): DesktopPopHeaders {
  const result: DesktopPopHeaders = {};
  for (const headerName of DESKTOP_POP_HEADER_NAMES) {
    const value = getHeaderValue(headers, headerName);
    if (value) {
      result[headerName] = value;
    }
  }
  return result;
}

function getHeaderValue(
  headers: IncomingHttpHeaders,
  headerName: string
): string | undefined {
  const headerValue = headers[headerName] ?? headers[headerName.toLowerCase()];
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Connection churn / reconnect / heartbeat-freshness counters
// Relay is a long-lived process; counters are monotonically increasing and
// reported as windowed rates in the emitted metric log lines.
// ---------------------------------------------------------------------------

let connectCount = 0;
let disconnectCount = 0;
let reconnectCount = 0;
// Per-target timestamp of last successful heartbeat ack (ms since epoch).
export const lastHeartbeatAckAt = new Map<string, number>();
const server = createServer(async (req, res) => {
  const url = parseRequestUrl(req);
  if (!url) {
    jsonResponse(res, 400, { error: "Invalid request" });
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    jsonResponse(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      connectedWorkers: workersByTargetId.size,
    });
    return;
  }

  if (url.pathname === "/dispatch" && req.method === "POST") {
    try {
      await handleDispatch(req, res, { targetRegistry, relayInstanceId });
    } catch (error) {
      respondInternalError(res, "Dispatch handler error", error);
    }
    return;
  }

  if (url.pathname === "/internal/dispatch" && req.method === "POST") {
    try {
      await handleInternalDispatch(req, res);
    } catch (error) {
      respondInternalError(res, "Internal dispatch handler error", error);
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
});

attachHttpServerErrorLogging(server);

// ---------------------------------------------------------------------------
// Socket.IO — generic event forwarder
// ---------------------------------------------------------------------------

const io = createSocketServer(server);

attachEngineConnectionErrorLogging(io);

// ---------------------------------------------------------------------------
// Keyless telemetry-only OTLP ingress (FEA-1989 / PRD-481 C1). A separate,
// UNAUTHENTICATED `/telemetry` namespace (multiplexed over the same single
// connection) that proxies opaque OTLP to a fixed collector origin. It shares
// no state with — and grants no access to — the authenticated command/DB-sync
// namespace below. Fails closed when RELAY_OTLP_COLLECTOR_URL is unset.
// ---------------------------------------------------------------------------

registerKeylessTelemetryNamespace(io, {
  collectorUrl: process.env.RELAY_OTLP_COLLECTOR_URL,
  allowPrivateCollector:
    process.env.RELAY_OTLP_ALLOW_PRIVATE_COLLECTOR_URL === "true",
  isProduction: process.env.NODE_ENV === "production",
  // Aggregate in-flight collector requests (≥1); connection budget (≥1); and
  // trusted reverse-proxy hops for X-Forwarded-For client-IP derivation (≥0,
  // set 1 behind the ALB).
  maxInflightExports: parseOptionalBoundedEnvInt(
    "RELAY_OTLP_MAX_INFLIGHT_EXPORTS",
    1
  ),
  maxConnections: parseOptionalBoundedEnvInt("RELAY_OTLP_MAX_CONNECTIONS", 1),
  trustedProxyHops: parseOptionalBoundedEnvInt(
    "RELAY_OTLP_TRUSTED_PROXY_HOPS",
    0
  ),
});

const namespace = io.of("/desktop-gateway");

namespace.use((socket, next) => {
  // Extract API key from handshake
  let apiKey: string | null = null;
  const authFields = socket.handshake.auth ?? {};
  log.info("Socket auth middleware: handshake received", {
    socketId: socket.id,
    hasAuthToken: typeof authFields.token === "string",
    hasAuthApiKey: typeof authFields.apiKey === "string",
    hasAuthHeader: typeof socket.handshake.headers.authorization === "string",
    authKeys: Object.keys(authFields),
  });

  if (typeof authFields.token === "string") {
    apiKey = authFields.token;
  } else if (typeof authFields.apiKey === "string") {
    apiKey = authFields.apiKey;
  }
  if (!apiKey) {
    const authHeader = socket.handshake.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      apiKey = authHeader.slice(7).trim();
    }
  }

  if (!apiKey) {
    log.warn("Socket auth middleware: no API key found in handshake", {
      socketId: socket.id,
      errorClass: ErrorClass.Connection,
    });
    next(new Error("Unauthorized"));
    return;
  }

  log.info("Socket auth middleware: extracted API key, validating via API", {
    socketId: socket.id,
    hasApiKey: Boolean(apiKey),
    vercelUrl: VERCEL_API_URL,
  });

  // Validate via Vercel
  forwardSocketEvent("_relay.validate", {
    apiKey,
    desktopPopHeaders: extractDesktopPopHeaders(socket.handshake.headers),
  })
    .then((result) => {
      log.info("Socket auth middleware: validation response", {
        socketId: socket.id,
        disconnect: result.disconnect,
        emitCount: result.emit.length,
        emitEvents: result.emit.map((e) => e.event),
      });

      if (result.disconnect || result.emit.length === 0) {
        log.warn("Socket auth middleware: validation rejected", {
          socketId: socket.id,
          disconnect: result.disconnect,
          emitCount: result.emit.length,
          errorClass: ErrorClass.Connection,
        });
        next(new Error("Unauthorized"));
        return;
      }

      // The validate handler returns auth context in emit[0].payload
      const authPayload = result.emit[0].payload as {
        organizationId: string;
        userId: string;
      };
      log.info("Socket auth middleware: authenticated", {
        socketId: socket.id,
        organizationId: authPayload.organizationId,
        userId: authPayload.userId,
      });
      socket.data.auth = authPayload;
      log.info("Connection socket accepted", {
        category: TelemetryCategory.ConnectionSocketAccepted,
        socketId: socket.id,
        organizationId: authPayload.organizationId,
      });
      next();
    })
    .catch((error) => {
      log.error("Socket auth middleware: validation threw", {
        socketId: socket.id,
        errorClass: ErrorClass.Connection,
        error,
      });
      next(new Error("Unauthorized"));
    });
});

// Clean up if a different socket was previously registered for this target
function cleanupExistingWorker(
  targetId: string,
  socket: Socket,
  gatewaySessionId?: string
): void {
  const existingWorker = workersByTargetId.get(targetId);
  if (!existingWorker || existingWorker.socket.id === socket.id) {
    return;
  }

  disposeWorkerTimers(existingWorker);
  emitConnectionState(
    ConnectionState.Disconnected,
    targetId,
    existingWorker.gatewaySessionId
  );
  socketToTarget.delete(existingWorker.socket.id);
  // Emit reconnecting event — a new socket is taking over for an existing target
  log.info("Connection reconnecting", {
    category: TelemetryCategory.ConnectionReconnecting,
    computeTargetId: targetId,
    gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    socketId: socket.id,
    previousSocketId: existingWorker.socket.id,
  });
  reconnectCount += 1;
  emitProtocolMetric({
    metric: "reconnect_frequency",
    origin: ORIGIN,
    count: reconnectCount,
    computeTargetId: targetId,
    gatewaySessionId: gatewaySessionId ?? undefined,
    timestamp: new Date().toISOString(),
  });
}

function registerWorker(
  socket: Socket,
  targetId: string,
  auth: { organizationId: string; userId: string; clerkUserId?: string },
  gatewaySessionId?: string
): void {
  cleanupOldWorker(socket, targetId, lastHeartbeatAckAt);
  cleanupExistingWorker(targetId, socket, gatewaySessionId);

  // Worker context object created first so heartbeat closure can reference it
  const workerContext: WorkerContext = {
    socket,
    targetId,
    organizationId: auth.organizationId,
    userId: auth.userId,
    heartbeatTimer: null,
    degradedTimer: null,
    wasDegraded: false,
    gatewaySessionId,
  };

  const heartbeatTimer = startWorkerHeartbeat({
    workerContext,
    targetId,
    gatewaySessionId,
    registry: targetRegistry,
    lastHeartbeatAckAt,
    intervalMs: RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS,
    degradedThresholdMs: HEARTBEAT_DEGRADED_THRESHOLD_MS,
    // ISS-8453: the heartbeat used to send `undefined`, and it shares the
    // cloud's 25s sampling slot with the desktop's own presence — so a
    // heartbeat arriving first consumed the slot and the sample carried no
    // occupancy at all. It reports the last occupancy the desktop stated.
    sendPresence: () =>
      forwardSocketEvent(
        "desktop.presence",
        heartbeatPresencePayload(workerContext),
        auth,
        targetId,
        gatewaySessionId
      ),
    isStillCurrentWorker: () =>
      workersByTargetId.get(targetId) === workerContext && socket.connected,
    emitConnectionState,
  });

  workerContext.heartbeatTimer = heartbeatTimer;

  // Treat takeover (different socket displacing an existing worker) as a first
  // registration so that an `online` metric is emitted for the new connection.
  const isTakeover =
    workersByTargetId.has(targetId) &&
    workersByTargetId.get(targetId)?.socket.id !== socket.id;
  const isFirstRegistration = !workersByTargetId.has(targetId) || isTakeover;

  // ISS-8531: both cleanups above early-return on the same-socket-same-target
  // path a repeated desktop.hello produces, so the context this write displaces
  // is disposed here instead. Timers only, no metric.
  const displaced = workersByTargetId.get(targetId);
  if (displaced !== workerContext) {
    disposeWorkerTimers(displaced);
  }
  workersByTargetId.set(targetId, workerContext);
  socketToTarget.set(socket.id, targetId);

  const token = `${relayInstanceId}:${socket.id}:${++ownerGeneration}`;
  workerContext.ownerToken = token;
  const registryMetadata: TargetMetadata = {
    instanceId: relayInstanceId,
    socketId: socket.id,
    ownerToken: token,
    organizationId: auth.organizationId,
    userId: auth.userId,
    connectedAt: Date.now(),
  };
  workerContext.registryMetadata = registryMetadata;
  targetRegistry.register(targetId, registryMetadata).then((registered) => {
    if (registered) {
      return;
    }
    // Non-fatal by design, but never silent again: an unregistered target is
    // invisible to every other relay instance, and until the heartbeat heal
    // existed this state lasted until the desktop reconnected. `register`
    // reports the refusal rather than throwing -- which is why there is no
    // `.catch` here -- so this is the only place the loss surfaces.
    log.error("Target registration failed; heartbeat reclaim will retry", {
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    });
  });

  const pending = socket.data.pendingBuffer;
  if (pending && pending.length > 0) {
    socket.data.pendingBuffer = [];
    for (const { event, args } of pending) {
      EventEmitter.prototype.emit.call(socket, event, ...args);
    }
  }

  if (isFirstRegistration) {
    emitConnectionState(ConnectionState.Online, targetId, gatewaySessionId);
  }

  log.info("Worker registered", {
    socketId: socket.id,
    targetId,
    gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
    organizationId: auth.organizationId,
    userId: auth.userId,
  });
}

// ---------------------------------------------------------------------------
// Per-socket serial queue for event forwarding.
// The API enforces strict sequential event ordering (seq 1, 2, 3…).
// Without serialization, concurrent HTTP forwards arrive out of order,
// causing "sequence_gap" rejections and slow retry loops.
// ---------------------------------------------------------------------------

const socketEventQueues = new Map<string, Promise<void>>();

function enqueueForSocket(socketId: string, fn: () => Promise<void>): void {
  const prev = socketEventQueues.get(socketId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  socketEventQueues.set(socketId, next);
}

namespace.on("connection", (socket) => {
  const auth = socket.data.auth as {
    organizationId: string;
    userId: string;
    clerkUserId?: string;
  };

  connectCount += 1;
  emitProtocolMetric({
    metric: "connection_churn_rate",
    origin: ORIGIN,
    count: connectCount,
    timestamp: new Date().toISOString(),
  });

  log.info("Worker socket connected", {
    socketId: socket.id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    transport: socket.conn.transport.name,
  });

  attachSocketErrorLogging(socket, {
    organizationId: auth.organizationId,
    userId: auth.userId,
  });

  // Buffer for events that arrive before desktop.hello registration completes
  socket.data.pendingBuffer = [];

  // Handle desktop.hello — registers target, returns pending commands
  socket.on("desktop.hello", async (payload: unknown) => {
    log.info("Received desktop.hello", {
      socketId: socket.id,
      organizationId: auth.organizationId,
      userId: auth.userId,
    });

    try {
      const result = await forwardSocketEvent("desktop.hello", payload, auth);

      if (result.disconnect) {
        log.warn("desktop.hello rejected by API, disconnecting", {
          socketId: socket.id,
          emitEvents: result.emit.map((e) => e.event),
        });
        // ISS-6126: deliver the rejection BEFORE closing. A refused hello comes
        // back as `{ emit: [desktop.hello.nack], disconnect: true }`, and
        // returning early discarded the only frame that says why.
        emitSocketEvents(socket, result.emit);
        drainPendingBuffer(socket);
        socket.disconnect(true);
        return;
      }

      // The call failed outright -- a 5xx, a non-JSON body, or a body whose
      // `emit` was not an array. Distinct from the API answering with no
      // target for this socket, and it must NOT be handled as that: an
      // unregistered socket left connected has no registry entry, no
      // heartbeat and no frame telling the desktop anything, so it buffers to
      // the cap and then drops events with nothing re-driving hello. The
      // network-failure catch below closes for exactly this reason; this arm
      // keeps the two symmetric (ISS-7976).
      //
      // `internal_error` must stay an already-shipped `DesktopHelloNackReason`
      // -- every installed desktop maps it today, so no new wire value ships.
      // Nack before disconnect: the frame that says why has to go out ahead of
      // the close (ISS-6126).
      if (result.forwardFailed) {
        log.error("desktop.hello forward failed, disconnecting", {
          socketId: socket.id,
          organizationId: auth.organizationId,
          userId: auth.userId,
          errorClass: ErrorClass.Connection,
        });
        emitHelloInternalErrorNack(socket);
        drainPendingBuffer(socket);
        socket.disconnect(true);
        return;
      }

      // Guard: socket may have disconnected during the async hello call
      if (!socket.connected) {
        return;
      }

      // Capture gatewaySessionId from the hello.ack response
      const gatewaySessionId = result.gatewaySessionId;

      if (result.targetId) {
        registerWorker(socket, result.targetId, auth, gatewaySessionId);
      } else {
        drainPendingBuffer(socket);
      }

      log.info("desktop.hello processed", {
        socketId: socket.id,
        targetId: result.targetId,
        gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
        emitCount: result.emit.length,
        events: result.emit.map((e) => e.event),
      });

      // Emit all response events to the worker
      emitSocketEvents(socket, result.emit);
    } catch (error) {
      log.error("Failed processing desktop.hello", {
        socketId: socket.id,
        organizationId: auth.organizationId,
        userId: auth.userId,
        error,
      });
      // ISS-11843: an unreachable API is not a refusal, and a desktop reads a
      // close with no nack as one.
      emitHelloInternalErrorNack(socket);
      drainPendingBuffer(socket);
      socket.disconnect(true);
    }
  });

  // Handle command events — forward to Vercel for DB persistence.
  // Events are queued per-socket to maintain sequential ordering.
  socket.on("desktop.command.event", (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      pushPendingBuffer(socket, "desktop.command.event", payload);
      return;
    }

    const worker = workersByTargetId.get(targetId);
    const gatewaySessionId = worker?.gatewaySessionId;
    const commandId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).commandId
        : undefined;
    const computeTargetId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).computeTargetId
        : undefined;

    log.info("Forwarding desktop.command.event", {
      socketId: socket.id,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      commandId,
      computeTargetId,
    });

    enqueueForSocket(socket.id, async () => {
      try {
        const result = await forwardSocketEvent(
          "desktop.command.event",
          payload,
          auth,
          targetId,
          gatewaySessionId
        );
        emitSocketEvents(socket, result.emit);
      } catch (error) {
        log.error("Failed forwarding command event", {
          socketId: socket.id,
          targetId,
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          commandId,
          computeTargetId,
          error,
        });
      }
    });
  });

  // Handle command ack — forward to Vercel
  socket.on("desktop.command.ack", async (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      pushPendingBuffer(socket, "desktop.command.ack", payload);
      return;
    }

    const worker = workersByTargetId.get(targetId);
    const gatewaySessionId = worker?.gatewaySessionId;
    const commandId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).commandId
        : undefined;
    const computeTargetId =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).computeTargetId
        : undefined;

    log.info("Forwarding desktop.command.ack", {
      socketId: socket.id,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      commandId,
      computeTargetId,
    });

    try {
      await forwardSocketEvent(
        "desktop.command.ack",
        payload,
        auth,
        targetId,
        gatewaySessionId
      );
    } catch (error) {
      log.error("Failed forwarding command ack", {
        socketId: socket.id,
        targetId,
        gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
        commandId,
        computeTargetId,
        error,
      });
    }
  });

  // Presence carries the desktop's `activeCommands`, the only source for
  // `executor_saturation` (ISS-8453). Trimmed to that field before forwarding.
  registerPresenceHandler(socket, auth);

  // Handle disconnect — notify Vercel, clean up local state
  socket.on("disconnect", (reason: string) => {
    socketEventQueues.delete(socket.id);

    const targetId = socketToTarget.get(socket.id);
    socketToTarget.delete(socket.id);

    if (targetId) {
      const worker = workersByTargetId.get(targetId);
      const isCurrentOwner = worker?.socket.id === socket.id;
      if (isCurrentOwner) {
        const gatewaySessionId = worker.gatewaySessionId;
        disposeWorkerTimers(worker);
        workersByTargetId.delete(targetId);
        lastHeartbeatAckAt.delete(targetId);
        if (worker.ownerToken) {
          targetRegistry
            .deregister(targetId, worker.ownerToken)
            .catch(() => {});
        }

        disconnectCount += 1;
        emitProtocolMetric({
          metric: "connection_churn_rate",
          origin: ORIGIN,
          count: disconnectCount,
          computeTargetId: targetId,
          gatewaySessionId: gatewaySessionId ?? undefined,
          timestamp: new Date().toISOString(),
        });

        emitConnectionState(
          ConnectionState.Disconnected,
          targetId,
          gatewaySessionId
        );

        // Only notify Vercel of disconnect if this socket is still the owner.
        // If another socket has taken over, Vercel already knows via its hello.
        forwardSocketEvent(
          "disconnect",
          undefined,
          auth,
          targetId,
          gatewaySessionId
        ).catch((error) => {
          log.error("Failed forwarding disconnect", {
            socketId: socket.id,
            targetId,
            gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
            organizationId: auth.organizationId,
            userId: auth.userId,
            errorClass: ErrorClass.Connection,
            error,
          });
        });

        log.info("Connection disconnected", {
          category: TelemetryCategory.ConnectionDisconnected,
          computeTargetId: targetId,
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          reason,
        });
        log.info("Worker socket disconnected", {
          socketId: socket.id,
          targetId,
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          organizationId: auth.organizationId,
          userId: auth.userId,
          reason,
        });
        return;
      }
    }

    log.info("Worker socket disconnected", {
      socketId: socket.id,
      targetId,
      organizationId: auth.organizationId,
      userId: auth.userId,
      reason,
    });
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

let relayServerStarted = false;

export async function startRelayServer(host = "0.0.0.0"): Promise<void> {
  if (relayServerStarted || server.listening) {
    relayServerStarted = true;
    return;
  }

  await initializeTargetRegistry();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(RELAY_PORT, host);
  });

  relayServerStarted = true;
  log.info(`Relay server listening on port ${RELAY_PORT}`);
}

export async function stopRelayServer(): Promise<void> {
  if (!(relayServerStarted && server.listening)) {
    relayServerStarted = false;
    return;
  }

  // io.close() disconnects all Socket.IO clients first, then closes the HTTP server.
  // Calling server.close() alone would wait for connections to drain; WebSocket
  // connections are long-lived, so the promise may never resolve.
  await io.close();

  relayServerStarted = false;
}

async function handleShutdown(): Promise<void> {
  try {
    if (instanceKeepaliveTimer) {
      clearInterval(instanceKeepaliveTimer);
      instanceKeepaliveTimer = null;
    }
    if (RELAY_RUNTIME_MODE === "redis") {
      // Anything this sweep misses stays routable to a dead instance for the
      // full TARGET_TTL_MS, so the count is the only pre-mortem signal there
      // is and must not be discarded (ISS-7976). The catch stays -- as `null`,
      // the honest "unknown", never a made-up 0 -- because a rejection here
      // would skip the rest of shutdown, including the flush that is what
      // actually gets this line out.
      const deregisteredTargets = await targetRegistry
        .deregisterAllByInstance(relayInstanceId)
        .catch(() => null);
      log.info("Relay shutdown: deregistered instance targets", {
        instanceId: relayInstanceId,
        deregisteredTargets,
        localWorkers: workersByTargetId.size,
      });
      await targetRegistry.deregisterInstance(relayInstanceId).catch(() => {});
    }
    for (const [targetId, ctx] of workersByTargetId) {
      emitConnectionState(
        ConnectionState.Disconnected,
        targetId,
        ctx.gatewaySessionId
      );
    }
    // Clear the map BEFORE awaiting the flush. If a socket disconnect fires
    // during the await window (e.g., a natural disconnect or io.close() from
    // an external stop), its handler would otherwise look up the worker, find
    // it still registered, and re-emit `disconnected` — producing a duplicate
    // transition for the same logical event. Clearing here makes the handler's
    // `isCurrentOwner` check fail-closed and skip the duplicate emission.
    workersByTargetId.clear();

    await flushLogsWithDeadline();
  } catch {
    // swallow — must still exit
  }
  process.exit(0);
}

async function initializeTargetRegistry(): Promise<void> {
  if (RELAY_RUNTIME_MODE !== "redis" || !process.env.REDIS_URL) {
    log.info("[relay] target registry: in-memory mode");
    return;
  }

  // A routable private IP is mandatory for Redis mode: peers reach this instance
  // for cross-instance dispatch via the address published in the registry.
  // Without one (ECS metadata missing/malformed) we must NOT publish a loopback
  // address — that would route peers back to their own host and make a live
  // remote target look unreachable. Degrade to in-memory mode instead.
  const privateIp = await resolvePrivateIp();
  if (!privateIp) {
    log.warn(
      "[relay] redis mode requested but no routable private IP could be resolved; falling back to in-memory mode"
    );
    return;
  }

  try {
    const redisClient = createRedisClient({
      url: process.env.REDIS_URL,
      keyPrefix: "relay:",
      logger: log,
      onError: (error) =>
        log.warn("[relay] redis error", { error: error.message }),
    });
    await redisClient.connect();
    targetRegistry = new RedisTargetRegistry(redisClient);

    relayInstanceId = await resolveInstanceId();

    await targetRegistry.registerInstance(relayInstanceId, {
      privateIp,
      port: RELAY_PORT,
      startedAt: Date.now(),
    });

    instanceKeepaliveTimer = setInterval(async () => {
      try {
        await targetRegistry.registerInstance(relayInstanceId, {
          privateIp,
          port: RELAY_PORT,
          startedAt: Date.now(),
        });
      } catch {
        // Non-fatal
      }
    }, 15_000);

    log.info(
      `[relay] target registry: redis mode (instance: ${relayInstanceId}, ip: ${privateIp})`
    );
  } catch (error) {
    targetRegistry = new InMemoryTargetRegistry();
    log.warn("[relay] redis init failed, falling back to in-memory mode", {
      error,
    });
  }
}

if (process.env.NODE_ENV !== "test") {
  startRelayServer().catch((error) => {
    log.error("Failed to start relay server", { error });
    process.exit(1);
  });

  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);
}
