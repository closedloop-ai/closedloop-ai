import "@repo/observability/telemetry/origin";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { log } from "@repo/observability/log";
import { emitProtocolMetric } from "@repo/observability/telemetry/metrics";
import {
  ErrorClass,
  TelemetryCategory,
} from "@repo/observability/telemetry/schema";
import { Server, type Socket } from "socket.io";
import { isRateLimited, remove as removeRateLimit } from "./rate-limiter";

const RELAY_PORT = Number(
  process.env.RELAY_PORT ?? process.env.MCP_PORT ?? "3020"
);
if (!Number.isInteger(RELAY_PORT) || RELAY_PORT < 1 || RELAY_PORT > 65_535) {
  log.error("Invalid RELAY_PORT");
  process.exit(1);
}
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const VERCEL_API_URL = process.env.CLOSEDLOOP_API_URL;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_DEGRADED_THRESHOLD_MS = Number(
  process.env.HEARTBEAT_DEGRADED_THRESHOLD_MS ??
    String(HEARTBEAT_INTERVAL_MS * 2)
);
const MAX_BODY_SIZE = 1_048_576; // 1 MB

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

type WorkerContext = {
  socket: Socket;
  targetId: string;
  organizationId: string;
  userId: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  degradedTimer: ReturnType<typeof setTimeout> | null;
  gatewaySessionId?: string;
  pluginVersion?: string;
};

const workersByTargetId = new Map<string, WorkerContext>();
const socketToTarget = new Map<string, string>();

// ---------------------------------------------------------------------------
// Connection churn / reconnect / heartbeat-freshness counters
// Relay is a long-lived process; counters are monotonically increasing and
// reported as windowed rates in the emitted metric log lines.
// ---------------------------------------------------------------------------

let connectCount = 0;
let disconnectCount = 0;
let reconnectCount = 0;
// Per-target timestamp of last successful heartbeat ack (ms since epoch).
const lastHeartbeatAckAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Vercel API client
// ---------------------------------------------------------------------------

async function callVercel<T = Record<string, unknown>>(
  path: string,
  body: unknown
): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  responseUrl: string;
  contentType: string | null;
  rawBody: string;
}> {
  const response = await fetch(`${VERCEL_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_API_SECRET as string,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const rawBody = await response.text();
  let data: T | null = null;

  try {
    data = JSON.parse(rawBody) as T;
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    responseUrl: response.url,
    contentType: response.headers.get("content-type"),
    rawBody,
  };
}

async function validateApiKeyViaApi(apiKey: string): Promise<{
  ok: boolean;
  context?: { organizationId: string; userId: string };
}> {
  log.info("validateApiKeyViaApi: calling API", {
    keyPrefix: `${apiKey.slice(0, 8)}...`,
    url: `${VERCEL_API_URL}/internal/api-keys/verify`,
  });

  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel("/internal/api-keys/verify", {
      key: apiKey,
    });

  log.info("validateApiKeyViaApi: API response", {
    ok,
    status,
    contentType,
    responseUrl,
    hasData: data !== null,
    rawBodyPreview: rawBody.slice(0, 300),
  });

  if (!(ok && data)) {
    log.error("validateApiKeyViaApi: verification failed - bad response", {
      status,
      responseUrl,
      contentType,
      response: data ?? rawBody.slice(0, 500),
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  const payload = data.data;
  if (
    data.success !== true ||
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).organizationId !== "string" ||
    typeof (payload as Record<string, unknown>).userId !== "string"
  ) {
    log.warn("validateApiKeyViaApi: payload shape mismatch", {
      success: data.success,
      payloadType: typeof payload,
      payloadKeys:
        typeof payload === "object" && payload !== null
          ? Object.keys(payload)
          : [],
      hasOrgId:
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).organizationId === "string",
      hasUserId:
        typeof payload === "object" &&
        payload !== null &&
        typeof (payload as Record<string, unknown>).userId === "string",
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  const scopes = (payload as Record<string, unknown>).scopes;
  if (!(Array.isArray(scopes) && scopes.includes("write"))) {
    log.warn("validateApiKeyViaApi: missing write scope", {
      scopes,
      errorClass: ErrorClass.Connection,
    });
    return { ok: false };
  }

  log.info("validateApiKeyViaApi: success", {
    organizationId: (payload as Record<string, unknown>)
      .organizationId as string,
  });

  return {
    ok: true,
    context: {
      organizationId: (payload as Record<string, unknown>)
        .organizationId as string,
      userId: (payload as Record<string, unknown>).userId as string,
    },
  };
}

async function forwardSocketEvent(
  event: string,
  payload: unknown,
  auth?: { organizationId: string; userId: string },
  targetId?: string,
  gatewaySessionId?: string
): Promise<{
  targetId?: string;
  gatewaySessionId?: string;
  emit: Array<{ event: string; payload: unknown }>;
  disconnect?: boolean;
}> {
  if (event === "_relay.validate") {
    const apiKey =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).apiKey === "string"
        ? ((payload as Record<string, unknown>).apiKey as string)
        : null;

    if (!apiKey) {
      return { emit: [], disconnect: true };
    }

    const result = await validateApiKeyViaApi(apiKey);
    if (!(result.ok && result.context)) {
      return { emit: [], disconnect: true };
    }

    return {
      emit: [
        {
          event: "_relay.auth",
          payload: result.context,
        },
      ],
    };
  }

  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel("/internal/relay/socket-event", {
      event,
      payload,
      auth,
      targetId,
      gatewaySessionId,
    });
  if (!(ok && data)) {
    log.error("Vercel socket-event call failed", {
      event,
      targetId,
      gatewaySessionId,
      status,
      responseUrl,
      contentType,
      response: data ?? rawBody.slice(0, 500),
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [] };
  }
  const result = data as Record<string, unknown>;
  if (!Array.isArray(result.emit)) {
    log.error("forwardSocketEvent: expected data.emit to be an array", {
      event,
      targetId,
      gatewaySessionId,
      emit: result.emit,
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [] };
  }
  return result as {
    targetId?: string;
    gatewaySessionId?: string;
    emit: Array<{ event: string; payload: unknown }>;
    disconnect?: boolean;
  };
}

// ---------------------------------------------------------------------------
// HTTP server — /health and /dispatch
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body exceeds 1 MB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function validateSecret(headerValue: string | string[] | undefined): boolean {
  if (typeof headerValue !== "string" || !INTERNAL_API_SECRET) {
    return false;
  }
  const digestKey = "relay-constant-time-compare";
  const expectedDigest = createHmac("sha256", digestKey)
    .update(INTERNAL_API_SECRET, "utf8")
    .digest();
  const actualDigest = createHmac("sha256", digestKey)
    .update(headerValue, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!validateSecret(req.headers["x-internal-secret"])) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("targetId" in payload) ||
    typeof (payload as Record<string, unknown>).targetId !== "string"
  ) {
    jsonResponse(res, 400, { error: "Missing targetId" });
    return;
  }

  const { targetId, operation } = payload as {
    targetId: string;
    operation: unknown;
  };
  const worker = workersByTargetId.get(targetId);
  if (!worker) {
    jsonResponse(res, 200, {
      delivered: false,
      reason: "target_not_connected",
    });
    return;
  }

  // Forward the command to the connected worker socket.
  // The operation is already in wire-envelope format from the Vercel API.
  log.info("Dispatch: emitting desktop.command to worker", {
    targetId,
    socketId: worker.socket.id,
    socketConnected: worker.socket.connected,
  });
  worker.socket.emit("desktop.command", operation);
  jsonResponse(res, 200, { delivered: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  );

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
      await handleDispatch(req, res);
    } catch (error) {
      log.error("Dispatch handler error", { error });
      jsonResponse(res, 500, { error: "Internal server error" });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
});

// ---------------------------------------------------------------------------
// Socket.IO — generic event forwarder
// ---------------------------------------------------------------------------

const io = new Server(server, {
  transports: ["websocket"],
  // CORS is irrelevant — only desktop workers connect via websocket with
  // API key auth, not browser clients. No browser origins will reach this server.
  cors: { origin: true, credentials: true },
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
    keyPrefix: `${apiKey.slice(0, 8)}...`,
    vercelUrl: VERCEL_API_URL,
  });

  // Validate via Vercel
  forwardSocketEvent("_relay.validate", { apiKey })
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
      log.info(
        JSON.stringify({
          category: TelemetryCategory.ConnectionSocketAccepted,
          timestamp: new Date().toISOString(),
          socketId: socket.id,
          organizationId: authPayload.organizationId,
        })
      );
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

function registerWorker(
  socket: Socket,
  targetId: string,
  auth: { organizationId: string; userId: string },
  gatewaySessionId?: string,
  pluginVersion?: string
): void {
  // Clean up if this socket was previously registered for a different target
  const oldTargetId = socketToTarget.get(socket.id);
  if (oldTargetId && oldTargetId !== targetId) {
    const oldWorker = workersByTargetId.get(oldTargetId);
    if (oldWorker?.socket.id === socket.id) {
      if (oldWorker.heartbeatTimer !== null) {
        clearInterval(oldWorker.heartbeatTimer);
      }
      if (oldWorker.degradedTimer !== null) {
        clearTimeout(oldWorker.degradedTimer);
      }
      workersByTargetId.delete(oldTargetId);
    }
  }

  // Clean up if a different socket was previously registered for this target
  const existingWorker = workersByTargetId.get(targetId);
  if (existingWorker && existingWorker.socket.id !== socket.id) {
    if (existingWorker.heartbeatTimer !== null) {
      clearInterval(existingWorker.heartbeatTimer);
    }
    if (existingWorker.degradedTimer !== null) {
      clearTimeout(existingWorker.degradedTimer);
    }
    socketToTarget.delete(existingWorker.socket.id);
    // Emit reconnecting event — a new socket is taking over for an existing target
    log.info(
      JSON.stringify({
        category: TelemetryCategory.ConnectionReconnecting,
        timestamp: new Date().toISOString(),
        computeTargetId: targetId,
        gatewaySessionId: gatewaySessionId ?? null,
        socketId: socket.id,
        previousSocketId: existingWorker.socket.id,
      })
    );
    reconnectCount += 1;
    emitProtocolMetric({
      metric: "reconnect_frequency",
      count: reconnectCount,
      computeTargetId: targetId,
      gatewaySessionId: gatewaySessionId ?? undefined,
      timestamp: new Date().toISOString(),
    });
  }

  // Worker context object created first so heartbeat closure can reference it
  const workerContext: WorkerContext = {
    socket,
    targetId,
    organizationId: auth.organizationId,
    userId: auth.userId,
    heartbeatTimer: null,
    degradedTimer: null,
    gatewaySessionId,
    pluginVersion,
  };

  let lastHeartbeatSuccess = Date.now();

  const heartbeatTimer = setInterval(() => {
    const heartbeatSentAt = Date.now();
    forwardSocketEvent(
      "desktop.presence",
      undefined,
      auth,
      targetId,
      gatewaySessionId
    )
      .then(() => {
        const now = Date.now();
        const prev = lastHeartbeatAckAt.get(targetId);
        lastHeartbeatSuccess = now;
        lastHeartbeatAckAt.set(targetId, now);
        // heartbeat_freshness = elapsed ms since previous successful ack.
        // Only emit once we have a previous ack to compare against.
        if (prev !== undefined) {
          emitProtocolMetric({
            metric: "heartbeat_freshness",
            value: now - prev,
            computeTargetId: targetId,
            gatewaySessionId: gatewaySessionId ?? undefined,
            timestamp: new Date(now).toISOString(),
          });
        }
        // Cancel any pending degraded timer on success
        if (workerContext.degradedTimer !== null) {
          clearTimeout(workerContext.degradedTimer);
          workerContext.degradedTimer = null;
        }
      })
      .catch((error) => {
        log.error("Heartbeat failed", { targetId, gatewaySessionId, error });
        const heartbeatFreshness = heartbeatSentAt - lastHeartbeatSuccess;
        log.warn(
          JSON.stringify({
            category: TelemetryCategory.ConnectionStaleHeartbeat,
            timestamp: new Date().toISOString(),
            computeTargetId: targetId,
            gatewaySessionId: gatewaySessionId ?? null,
            heartbeatFreshness,
          })
        );
        // Schedule a degraded event if not already pending
        workerContext.degradedTimer ??= setTimeout(() => {
          workerContext.degradedTimer = null;
          const freshness = Date.now() - lastHeartbeatSuccess;
          log.warn(
            JSON.stringify({
              category: TelemetryCategory.ConnectionDegraded,
              timestamp: new Date().toISOString(),
              computeTargetId: targetId,
              gatewaySessionId: gatewaySessionId ?? null,
              heartbeatFreshness: freshness,
            })
          );
        }, HEARTBEAT_DEGRADED_THRESHOLD_MS);
      });
  }, HEARTBEAT_INTERVAL_MS);

  workerContext.heartbeatTimer = heartbeatTimer;

  workersByTargetId.set(targetId, workerContext);
  socketToTarget.set(socket.id, targetId);

  log.info("Worker registered", {
    socketId: socket.id,
    targetId,
    gatewaySessionId,
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
  };

  connectCount += 1;
  emitProtocolMetric({
    metric: "connection_churn_rate",
    count: connectCount,
    timestamp: new Date().toISOString(),
  });

  log.info("Worker socket connected", {
    socketId: socket.id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    transport: socket.conn.transport.name,
  });

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
        });
        socket.disconnect(true);
        return;
      }

      // Guard: socket may have disconnected during the async hello call
      if (!socket.connected) {
        return;
      }

      // Capture gatewaySessionId from the hello.ack response
      const gatewaySessionId = result.gatewaySessionId;

      // Extract pluginVersion from the hello payload sent by the desktop client
      const pluginVersion =
        typeof payload === "object" && payload !== null
          ? ((payload as Record<string, unknown>).pluginVersion as
              | string
              | undefined)
          : undefined;

      if (result.targetId) {
        registerWorker(
          socket,
          result.targetId,
          auth,
          gatewaySessionId,
          pluginVersion
        );
      }

      log.info("desktop.hello processed", {
        socketId: socket.id,
        targetId: result.targetId,
        gatewaySessionId,
        emitCount: result.emit.length,
        events: result.emit.map((e) => e.event),
      });

      // Emit all response events to the worker
      for (const { event, payload: eventPayload } of result.emit) {
        socket.emit(event, eventPayload);
      }
    } catch (error) {
      log.error("Failed processing desktop.hello", {
        socketId: socket.id,
        organizationId: auth.organizationId,
        userId: auth.userId,
        error,
      });
      socket.disconnect(true);
    }
  });

  // Handle command events — forward to Vercel for DB persistence.
  // Events are queued per-socket to maintain sequential ordering.
  socket.on("desktop.command.event", (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      log.warn("Received command.event but no targetId for socket", {
        socketId: socket.id,
      });
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
      gatewaySessionId,
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
        for (const { event, payload: eventPayload } of result.emit) {
          socket.emit(event, eventPayload);
        }
      } catch (error) {
        log.error("Failed forwarding command event", {
          socketId: socket.id,
          targetId,
          gatewaySessionId,
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
      log.warn("Received command.ack but no targetId for socket", {
        socketId: socket.id,
      });
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
      gatewaySessionId,
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
        gatewaySessionId,
        commandId,
        computeTargetId,
        error,
      });
    }
  });

  // Handle telemetry events — forward to Vercel with rate limiting.
  socket.on("desktop.telemetry", (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      log.warn("Received desktop.telemetry but no targetId for socket", {
        socketId: socket.id,
      });
      return;
    }

    if (isRateLimited(socket.id)) {
      log.info("desktop.telemetry rate_limited", {
        socketId: socket.id,
        targetId,
      });
      return;
    }

    const worker = workersByTargetId.get(targetId);
    const gatewaySessionId = worker?.gatewaySessionId;
    const pluginVersion = worker?.pluginVersion;

    const enrichedPayload =
      typeof payload === "object" && payload !== null
        ? { ...(payload as Record<string, unknown>), pluginVersion }
        : { pluginVersion };

    forwardSocketEvent(
      "desktop.telemetry",
      enrichedPayload,
      auth,
      targetId,
      gatewaySessionId
    )
      .then((result) => {
        for (const { event, payload: ep } of result.emit) {
          socket.emit(event, ep);
        }
      })
      .catch((err) => {
        log.error("Failed forwarding desktop.telemetry", {
          socketId: socket.id,
          targetId,
          gatewaySessionId,
          error: err,
        });
      });
  });

  // Handle presence — forward to Vercel for heartbeat
  socket.on("desktop.presence", async () => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      return;
    }

    const worker = workersByTargetId.get(targetId);
    const gatewaySessionId = worker?.gatewaySessionId;

    try {
      await forwardSocketEvent(
        "desktop.presence",
        undefined,
        auth,
        targetId,
        gatewaySessionId
      );
    } catch (error) {
      log.error("Failed forwarding presence", {
        socketId: socket.id,
        targetId,
        gatewaySessionId,
        error,
      });
    }
  });

  // Handle disconnect — notify Vercel, clean up local state
  socket.on("disconnect", (reason: string) => {
    socketEventQueues.delete(socket.id);
    removeRateLimit(socket.id);

    const targetId = socketToTarget.get(socket.id);
    socketToTarget.delete(socket.id);

    if (targetId) {
      const worker = workersByTargetId.get(targetId);
      const isCurrentOwner = worker?.socket.id === socket.id;
      if (isCurrentOwner) {
        const gatewaySessionId = worker.gatewaySessionId;
        if (worker.heartbeatTimer !== null) {
          clearInterval(worker.heartbeatTimer);
        }
        if (worker.degradedTimer !== null) {
          clearTimeout(worker.degradedTimer);
        }
        workersByTargetId.delete(targetId);
        lastHeartbeatAckAt.delete(targetId);

        disconnectCount += 1;
        emitProtocolMetric({
          metric: "connection_churn_rate",
          count: disconnectCount,
          computeTargetId: targetId,
          gatewaySessionId: gatewaySessionId ?? undefined,
          timestamp: new Date().toISOString(),
        });

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
            gatewaySessionId,
            organizationId: auth.organizationId,
            userId: auth.userId,
            errorClass: ErrorClass.Connection,
            error,
          });
        });

        log.info(
          JSON.stringify({
            category: TelemetryCategory.ConnectionDisconnected,
            timestamp: new Date().toISOString(),
            computeTargetId: targetId,
            gatewaySessionId: gatewaySessionId ?? null,
            reason,
          })
        );
        log.info("Worker socket disconnected", {
          socketId: socket.id,
          targetId,
          gatewaySessionId,
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

if (process.env.NODE_ENV !== "test") {
  startRelayServer().catch((error) => {
    log.error("Failed to start relay server", { error });
    process.exit(1);
  });
}
