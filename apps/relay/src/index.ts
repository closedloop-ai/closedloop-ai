import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { log } from "@repo/observability/log";
import { Server, type Socket } from "socket.io";

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
  heartbeatTimer: ReturnType<typeof setInterval>;
};

const workersByTargetId = new Map<string, WorkerContext>();
const socketToTarget = new Map<string, string>();

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
  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel("/internal/api-keys/verify", {
      key: apiKey,
    });

  if (!(ok && data)) {
    log.error("Vercel api-key verification failed", {
      status,
      responseUrl,
      contentType,
      response: data ?? rawBody.slice(0, 500),
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
    return { ok: false };
  }

  const scopes = (payload as Record<string, unknown>).scopes;
  if (!(Array.isArray(scopes) && scopes.includes("write"))) {
    return { ok: false };
  }

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
  targetId?: string
): Promise<{
  targetId?: string;
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
    });
  if (!(ok && data)) {
    log.error("Vercel socket-event call failed", {
      event,
      status,
      responseUrl,
      contentType,
      response: data ?? rawBody.slice(0, 500),
    });
    return { emit: [] };
  }
  const result = data as Record<string, unknown>;
  if (!Array.isArray(result.emit)) {
    log.error("forwardSocketEvent: expected data.emit to be an array", {
      event,
      emit: result.emit,
    });
    return { emit: [] };
  }
  return result as {
    targetId?: string;
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
  if (typeof socket.handshake.auth?.token === "string") {
    apiKey = socket.handshake.auth.token;
  } else if (typeof socket.handshake.auth?.apiKey === "string") {
    apiKey = socket.handshake.auth.apiKey;
  }
  if (!apiKey) {
    const authHeader = socket.handshake.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      apiKey = authHeader.slice(7).trim();
    }
  }

  if (!apiKey) {
    next(new Error("Unauthorized"));
    return;
  }

  // Validate via Vercel
  forwardSocketEvent("_relay.validate", { apiKey })
    .then((result) => {
      if (result.disconnect || result.emit.length === 0) {
        next(new Error("Unauthorized"));
        return;
      }

      // The validate handler returns auth context in emit[0].payload
      const authPayload = result.emit[0].payload as {
        organizationId: string;
        userId: string;
      };
      socket.data.auth = authPayload;
      next();
    })
    .catch((error) => {
      log.error("Socket auth validation failed", { error });
      next(new Error("Unauthorized"));
    });
});

function registerWorker(
  socket: Socket,
  targetId: string,
  auth: { organizationId: string; userId: string }
): void {
  // Clean up if this socket was previously registered for a different target
  const oldTargetId = socketToTarget.get(socket.id);
  if (oldTargetId && oldTargetId !== targetId) {
    const oldWorker = workersByTargetId.get(oldTargetId);
    if (oldWorker?.socket.id === socket.id) {
      clearInterval(oldWorker.heartbeatTimer);
      workersByTargetId.delete(oldTargetId);
    }
  }

  // Clean up if a different socket was previously registered for this target
  const existingWorker = workersByTargetId.get(targetId);
  if (existingWorker && existingWorker.socket.id !== socket.id) {
    clearInterval(existingWorker.heartbeatTimer);
    socketToTarget.delete(existingWorker.socket.id);
  }

  const heartbeatTimer = setInterval(() => {
    forwardSocketEvent("desktop.presence", undefined, auth, targetId).catch(
      (error) => {
        log.error("Heartbeat failed", { targetId, error });
      }
    );
  }, HEARTBEAT_INTERVAL_MS);

  workersByTargetId.set(targetId, {
    socket,
    targetId,
    organizationId: auth.organizationId,
    userId: auth.userId,
    heartbeatTimer,
  });
  socketToTarget.set(socket.id, targetId);
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

  log.info("Worker socket connected", {
    socketId: socket.id,
    organizationId: auth.organizationId,
    userId: auth.userId,
  });

  // Handle desktop.hello — registers target, returns pending commands
  socket.on("desktop.hello", async (payload: unknown) => {
    try {
      const result = await forwardSocketEvent("desktop.hello", payload, auth);

      if (result.disconnect) {
        socket.disconnect(true);
        return;
      }

      // Guard: socket may have disconnected during the async hello call
      if (!socket.connected) {
        return;
      }

      if (result.targetId) {
        registerWorker(socket, result.targetId, auth);
      }

      log.info("Hello result", {
        socketId: socket.id,
        targetId: result.targetId,
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

    log.info("Forwarding desktop.command.event", {
      socketId: socket.id,
      targetId,
      commandId:
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).commandId
          : undefined,
    });

    enqueueForSocket(socket.id, async () => {
      try {
        const result = await forwardSocketEvent(
          "desktop.command.event",
          payload,
          auth,
          targetId
        );
        for (const { event, payload: eventPayload } of result.emit) {
          socket.emit(event, eventPayload);
        }
      } catch (error) {
        log.error("Failed forwarding command event", {
          socketId: socket.id,
          targetId,
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

    log.info("Forwarding desktop.command.ack", {
      socketId: socket.id,
      targetId,
      commandId:
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).commandId
          : undefined,
    });

    try {
      await forwardSocketEvent("desktop.command.ack", payload, auth, targetId);
    } catch (error) {
      log.error("Failed forwarding command ack", {
        socketId: socket.id,
        targetId,
        error,
      });
    }
  });

  // Handle presence — forward to Vercel for heartbeat
  socket.on("desktop.presence", async () => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      return;
    }

    try {
      await forwardSocketEvent("desktop.presence", undefined, auth, targetId);
    } catch (error) {
      log.error("Failed forwarding presence", {
        socketId: socket.id,
        targetId,
        error,
      });
    }
  });

  // Handle disconnect — notify Vercel, clean up local state
  socket.on("disconnect", () => {
    socketEventQueues.delete(socket.id);
    const targetId = socketToTarget.get(socket.id);
    socketToTarget.delete(socket.id);

    if (targetId) {
      const worker = workersByTargetId.get(targetId);
      const isCurrentOwner = worker?.socket.id === socket.id;
      if (isCurrentOwner) {
        clearInterval(worker.heartbeatTimer);
        workersByTargetId.delete(targetId);

        // Only notify Vercel of disconnect if this socket is still the owner.
        // If another socket has taken over, Vercel already knows via its hello.
        forwardSocketEvent("disconnect", undefined, auth, targetId).catch(
          (error) => {
            log.error("Failed forwarding disconnect", { targetId, error });
          }
        );
      }
    }

    log.info("Worker socket disconnected", {
      socketId: socket.id,
      targetId,
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
