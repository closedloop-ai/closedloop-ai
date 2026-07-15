import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  type DesktopAgentSessionsAck,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import {
  DESKTOP_POP_HEADER_NAMES,
  type DesktopPopHeaderName,
} from "@repo/api/src/types/api-key";
import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  type DesktopAnalyticsAck,
  DesktopAnalyticsAckReason,
} from "@repo/api/src/types/desktop-analytics";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import {
  ConnectionState,
  emitProtocolMetric,
  type ProtocolMetric,
} from "@repo/observability/telemetry/metrics";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import {
  ErrorClass,
  isLoopPerfTelemetryRateLimitBypass,
  TelemetryCategory,
} from "@repo/observability/telemetry/schema";
import { createRedisClient } from "@repo/redis";
import { Server, type Socket } from "socket.io";
import {
  isRoutablePrivateIpv4,
  resolveInstanceId,
  resolvePrivateIp,
} from "./instance-discovery.js";
import { registerKeylessTelemetryNamespace } from "./keyless-otlp-ingress.js";
import {
  createRateLimiter,
  isRateLimited,
  remove as removeRateLimit,
} from "./rate-limiter";
import {
  InMemoryTargetRegistry,
  type InstanceInfo,
  RedisTargetRegistry,
  type TargetMetadata,
  type TargetRegistry,
} from "./target-registry.js";

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
const SHUTDOWN_FLUSH_DEADLINE_MS = 5000;
const MAX_BODY_SIZE = 1_048_576; // 1 MB
const MAX_PENDING_BUFFER_SIZE = 100;
const RELAY_RUNTIME_MODE = process.env.RELAY_RUNTIME_MODE ?? "inmemory";
const RELAY_INTERNAL_ALLOWED_IPS = (
  process.env.RELAY_INTERNAL_ALLOWED_IPS ?? ""
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost:\d+$/;

/**
 * Socket.IO CORS origin guard. Desktop workers connect via Node
 * socket.io-client and send no browser Origin header, so those are always
 * allowed. Any request that carries an Origin is a browser — none are expected
 * here — so it is rejected (localhost permitted in non-production for local
 * tooling). This keeps the credentialed `/desktop-gateway` namespace closed to
 * arbitrary sites even if the websocket-only transport is ever broadened.
 */
function isAllowedSocketOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  return (
    process.env.NODE_ENV !== "production" && LOCALHOST_ORIGIN_REGEX.test(origin)
  );
}

let targetRegistry: TargetRegistry = new InMemoryTargetRegistry();
let relayInstanceId = "unknown";
let ownerGeneration = 0;
let instanceKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

const LOOP_PERF_TELEMETRY_RATE_LIMIT_WINDOW_MS = 60_000;
let loopPerfTelemetryRateLimitPerMinute = Number(
  process.env.LOOP_PERF_TELEMETRY_RATE_LIMIT_PER_MINUTE ?? "240"
);
if (
  !Number.isFinite(loopPerfTelemetryRateLimitPerMinute) ||
  loopPerfTelemetryRateLimitPerMinute <= 0
) {
  log.warn(
    "Invalid LOOP_PERF_TELEMETRY_RATE_LIMIT_PER_MINUTE, defaulting to 240"
  );
  loopPerfTelemetryRateLimitPerMinute = 240;
}

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
  clerkUserId?: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  degradedTimer: ReturnType<typeof setTimeout> | null;
  wasDegraded: boolean;
  gatewaySessionId?: string;
  pluginVersion?: string;
  ownerToken?: string;
};

type DesktopPopHeaders = Partial<Record<DesktopPopHeaderName, string>>;

const workersByTargetId = new Map<string, WorkerContext>();
const socketToTarget = new Map<string, string>();
const loopPerfTelemetryRateLimiter = createRateLimiter(
  loopPerfTelemetryRateLimitPerMinute,
  LOOP_PERF_TELEMETRY_RATE_LIMIT_WINDOW_MS
);

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

function toDesktopPopHeaders(value: unknown): DesktopPopHeaders | undefined {
  if (!(typeof value === "object" && value !== null)) {
    return undefined;
  }

  const result: DesktopPopHeaders = {};
  for (const headerName of DESKTOP_POP_HEADER_NAMES) {
    const headerValue = (value as Record<string, unknown>)[headerName];
    if (typeof headerValue === "string" && headerValue.trim().length > 0) {
      result[headerName] = headerValue;
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
const lastHeartbeatAckAt = new Map<string, number>();
const DEFAULT_VERCEL_CALL_TIMEOUT_MS = 10_000;
const AGENT_SESSIONS_SOCKET_EVENT_TIMEOUT_MS = 30_000;
// Cross-instance proxy dispatch must finish well inside the API caller's budget.
// apps/api/lib/loops/loop-desktop.ts aborts the POST /dispatch request after
// 5000ms; a peer timeout at or above that lets a slow peer outlive the upstream
// request, so the API reports failure while the peer is still working. Keep this
// comfortably below 5000ms so the relay can return an explicit not-delivered
// result before the caller gives up.
export const API_DISPATCH_CALLER_TIMEOUT_MS = 5000;
export const PEER_DISPATCH_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Vercel API client
// ---------------------------------------------------------------------------

async function callVercel<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  extraHeaders?: DesktopPopHeaders,
  timeoutMs = DEFAULT_VERCEL_CALL_TIMEOUT_MS
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
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

async function validateApiKeyViaApi(
  apiKey: string,
  desktopPopHeaders?: DesktopPopHeaders
): Promise<{
  ok: boolean;
  context?: { organizationId: string; userId: string; clerkUserId?: string };
}> {
  log.info("validateApiKeyViaApi: calling API", {
    hasApiKey: Boolean(apiKey),
    url: `${VERCEL_API_URL}/internal/api-keys/verify`,
    hasDesktopPopHeaders:
      Object.keys(desktopPopHeaders ?? {}).length ===
      DESKTOP_POP_HEADER_NAMES.length,
  });

  const { ok, data, status, responseUrl, contentType, rawBody } =
    await callVercel(
      "/internal/api-keys/verify",
      {
        key: apiKey,
        desktopPopRequired: true,
      },
      desktopPopHeaders
    );

  log.info("validateApiKeyViaApi: API response", {
    ok,
    status,
    contentType,
    responseUrl,
    hasData: data !== null,
  });

  if (!(ok && data)) {
    log.error("validateApiKeyViaApi: verification failed - bad response", {
      status,
      responseUrl,
      contentType,
      responseLength: rawBody.length,
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

  const clerkUserId =
    typeof (payload as Record<string, unknown>).clerkUserId === "string"
      ? ((payload as Record<string, unknown>).clerkUserId as string)
      : undefined;

  return {
    ok: true,
    context: {
      organizationId: (payload as Record<string, unknown>)
        .organizationId as string,
      userId: (payload as Record<string, unknown>).userId as string,
      ...(clerkUserId ? { clerkUserId } : {}),
    },
  };
}

async function forwardSocketEvent(
  event: string,
  payload: unknown,
  auth?: { organizationId: string; userId: string; clerkUserId?: string },
  targetId?: string,
  gatewaySessionId?: string,
  relaySocketId?: string
): Promise<{
  targetId?: string;
  gatewaySessionId?: string;
  emit: Array<{ event: string; payload: unknown }>;
  ack?: unknown;
  disconnect?: boolean;
}> {
  if (event === "_relay.validate") {
    const apiKey =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).apiKey === "string"
        ? ((payload as Record<string, unknown>).apiKey as string)
        : null;
    const desktopPopHeaders =
      typeof payload === "object" && payload !== null
        ? toDesktopPopHeaders(
            (payload as Record<string, unknown>).desktopPopHeaders
          )
        : undefined;

    if (!apiKey) {
      return { emit: [], disconnect: true };
    }

    const result = await validateApiKeyViaApi(apiKey, desktopPopHeaders);
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
    await callVercel(
      "/internal/relay/socket-event",
      {
        event,
        payload,
        auth,
        targetId,
        gatewaySessionId,
        relaySocketId,
      },
      undefined,
      event === DESKTOP_AGENT_SESSIONS_SOCKET_EVENT
        ? AGENT_SESSIONS_SOCKET_EVENT_TIMEOUT_MS
        : DEFAULT_VERCEL_CALL_TIMEOUT_MS
    );
  if (!(ok && data)) {
    log.error("Vercel socket-event call failed", {
      event,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      status,
      responseUrl,
      contentType,
      responseLength: rawBody.length,
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [] };
  }
  const result = data as Record<string, unknown>;
  if (!Array.isArray(result.emit)) {
    log.error("forwardSocketEvent: expected data.emit to be an array", {
      event,
      targetId,
      gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
      emit: result.emit,
      errorClass: ErrorClass.Protocol,
    });
    return { emit: [] };
  }
  return result as {
    targetId?: string;
    gatewaySessionId?: string;
    emit: Array<{ event: string; payload: unknown }>;
    ack?: unknown;
    disconnect?: boolean;
  };
}

const knownDesktopAnalyticsAckReasons = new Set<string>(
  Object.values(DesktopAnalyticsAckReason)
);

function toDesktopAnalyticsAck(value: unknown): DesktopAnalyticsAck {
  if (!value || typeof value !== "object") {
    return {
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    };
  }
  const record = value as Record<string, unknown>;
  if (record.accepted === true) {
    return { accepted: true };
  }
  if (
    typeof record.reason === "string" &&
    knownDesktopAnalyticsAckReasons.has(record.reason)
  ) {
    return {
      accepted: false,
      reason: record.reason as DesktopAnalyticsAckReason,
    };
  }
  return {
    accepted: false,
    reason: DesktopAnalyticsAckReason.ValidationFailed,
  };
}

const knownAgentSessionsAckReasons = new Set<string>(
  Object.values(DesktopAgentSessionsAckReason)
);

function toDesktopAgentSessionsAck(value: unknown): DesktopAgentSessionsAck {
  if (!value || typeof value !== "object") {
    return {
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    };
  }
  const record = value as Record<string, unknown>;
  if (record.accepted === true) {
    return { accepted: true };
  }
  if (
    typeof record.reason === "string" &&
    knownAgentSessionsAckReasons.has(record.reason)
  ) {
    return {
      accepted: false,
      reason: record.reason as DesktopAgentSessionsAckReason,
    };
  }
  return {
    accepted: false,
    reason: DesktopAgentSessionsAckReason.IngestionFailed,
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

type DispatchPayload = { targetId: string; operation: unknown };

type DispatchParseResult =
  | { ok: true; payload: DispatchPayload }
  | { ok: false; error: string };

// Pure validation, decoupled from the HTTP cycle so it can be unit-tested in
// isolation. Callers own the response: parseDispatchBody below sends the 400.
export function parseDispatchPayload(raw: string): DispatchParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).targetId !== "string"
  ) {
    return { ok: false, error: "Missing targetId" };
  }

  return { ok: true, payload: body as DispatchPayload };
}

async function parseDispatchBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<DispatchPayload | null> {
  const result = parseDispatchPayload(await readBody(req));
  if (!result.ok) {
    jsonResponse(res, 400, { error: result.error });
    return null;
  }
  return result.payload;
}

async function handleDispatch(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!validateSecret(req.headers["x-internal-secret"])) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  const payload = await parseDispatchBody(req, res);
  if (!payload) {
    return;
  }

  const { targetId, operation } = payload;
  const worker = workersByTargetId.get(targetId);

  // Ownership check: in Redis mode the shared registry — not this process's
  // socket map — is the source of truth for which relay instance currently owns
  // a target. A desktop that reconnected to a different relay re-registers in
  // Redis while this instance may still hold a stale local socket for the same
  // target. Emitting to that stale socket would double-route the command, so
  // when the registry attributes the target to another owner we proxy to the
  // registered owner (or report not connected) rather than emitting locally.
  if (!(worker && (await isLocalWorkerCurrentOwner(targetId, worker)))) {
    const proxyResult = await tryProxyDispatch(targetId, operation);
    if (proxyResult) {
      jsonResponse(res, 200, proxyResult);
      return;
    }
    jsonResponse(res, 200, {
      delivered: false,
      reason: "target_not_connected",
    });
    return;
  }

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

  if (url.pathname === "/internal/dispatch" && req.method === "POST") {
    try {
      await handleInternalDispatch(req, res);
    } catch (error) {
      log.error("Internal dispatch handler error", { error });
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
  // Only desktop workers connect, via websocket with API key auth — not browser
  // clients. The origin guard rejects any browser Origin as defense-in-depth so
  // that re-adding a polling transport could never expose this credentialed
  // namespace to arbitrary sites.
  cors: {
    origin: (origin, callback) => callback(null, isAllowedSocketOrigin(origin)),
    credentials: true,
  },
});

// ---------------------------------------------------------------------------
// Keyless telemetry-only OTLP ingress (FEA-1989 / PRD-481 C1). A separate,
// UNAUTHENTICATED `/telemetry` namespace (multiplexed over the same single
// connection) that proxies opaque OTLP to a fixed collector origin. It shares
// no state with — and grants no access to — the authenticated command/DB-sync
// namespace below. Fails closed when RELAY_OTLP_COLLECTOR_URL is unset.
// ---------------------------------------------------------------------------
// Keyless telemetry capacity / back-pressure knobs (FEA-1994 / PRD-481 C6).
// Return undefined when unset/invalid so the ingress module's built-in defaults
// stay the single source of truth (no default duplicated here).
function parseOptionalBoundedEnvInt(
  name: string,
  min: number
): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    log.warn(`Invalid ${name}, ignoring (using built-in default)`, {
      value: raw,
      min,
    });
    return undefined;
  }
  return value;
}

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

// Clean up if this socket was previously registered for a different target
function cleanupOldWorker(socket: Socket, newTargetId: string): void {
  const oldTargetId = socketToTarget.get(socket.id);
  if (!oldTargetId || oldTargetId === newTargetId) {
    return;
  }

  const oldWorker = workersByTargetId.get(oldTargetId);
  if (oldWorker?.socket.id !== socket.id) {
    return;
  }

  if (oldWorker.heartbeatTimer !== null) {
    clearInterval(oldWorker.heartbeatTimer);
  }
  if (oldWorker.degradedTimer !== null) {
    clearTimeout(oldWorker.degradedTimer);
  }
  workersByTargetId.delete(oldTargetId);
}

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

  if (existingWorker.heartbeatTimer !== null) {
    clearInterval(existingWorker.heartbeatTimer);
  }
  if (existingWorker.degradedTimer !== null) {
    clearTimeout(existingWorker.degradedTimer);
  }
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

function pushPendingBuffer(
  socket: Socket,
  event: string,
  ...args: unknown[]
): void {
  if (socket.data.pendingBuffer.length >= MAX_PENDING_BUFFER_SIZE) {
    log.warn("Pending buffer full, dropping event", {
      socketId: socket.id,
      event,
    });
    if (event === DESKTOP_AGENT_SESSIONS_SOCKET_EVENT) {
      (args[1] as ((response: DesktopAgentSessionsAck) => void) | undefined)?.({
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    } else if (event === DESKTOP_ANALYTICS_SOCKET_EVENT) {
      (args[1] as ((response: DesktopAnalyticsAck) => void) | undefined)?.({
        accepted: false,
        reason: DesktopAnalyticsAckReason.ValidationFailed,
      });
    }
    return;
  }
  socket.data.pendingBuffer.push({ event, args });
}

function drainPendingBuffer(socket: Socket): void {
  const pending = socket.data.pendingBuffer;
  if (!pending || pending.length === 0) {
    return;
  }
  socket.data.pendingBuffer = [];
  for (const { event, args } of pending) {
    if (event === DESKTOP_AGENT_SESSIONS_SOCKET_EVENT) {
      (args[1] as ((response: DesktopAgentSessionsAck) => void) | undefined)?.({
        accepted: false,
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
      });
    } else if (event === DESKTOP_ANALYTICS_SOCKET_EVENT) {
      (args[1] as ((response: DesktopAnalyticsAck) => void) | undefined)?.({
        accepted: false,
        reason: DesktopAnalyticsAckReason.ValidationFailed,
      });
    }
  }
}

function registerWorker(
  socket: Socket,
  targetId: string,
  auth: { organizationId: string; userId: string; clerkUserId?: string },
  gatewaySessionId?: string,
  pluginVersion?: string
): void {
  cleanupOldWorker(socket, targetId);
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
        if (workerContext.ownerToken) {
          targetRegistry
            .refreshTtl(targetId, workerContext.ownerToken)
            .catch(() => {});
        }
        // heartbeat_freshness = elapsed ms since previous successful ack.
        // Only emit once we have a previous ack to compare against.
        if (prev !== undefined) {
          emitProtocolMetric({
            metric: "heartbeat_freshness",
            origin: ORIGIN,
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
        // Emit recovery if connection was previously degraded
        if (workerContext.wasDegraded) {
          emitConnectionState(
            ConnectionState.Online,
            targetId,
            gatewaySessionId
          );
          workerContext.wasDegraded = false;
        }
      })
      .catch((error) => {
        log.error("Heartbeat failed", {
          targetId,
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          error,
        });
        const heartbeatFreshness = heartbeatSentAt - lastHeartbeatSuccess;
        log.warn("Connection stale heartbeat", {
          category: TelemetryCategory.ConnectionStaleHeartbeat,
          computeTargetId: targetId,
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          heartbeatFreshness,
        });
        // Schedule a degraded event if not already pending
        workerContext.degradedTimer ??= setTimeout(() => {
          workerContext.degradedTimer = null;
          const freshness = Date.now() - lastHeartbeatSuccess;
          log.warn("Connection degraded", {
            category: TelemetryCategory.ConnectionDegraded,
            computeTargetId: targetId,
            gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
            heartbeatFreshness: freshness,
          });
          emitConnectionState(
            ConnectionState.Degraded,
            targetId,
            gatewaySessionId
          );
          workerContext.wasDegraded = true;
        }, HEARTBEAT_DEGRADED_THRESHOLD_MS);
      });
  }, HEARTBEAT_INTERVAL_MS);

  workerContext.heartbeatTimer = heartbeatTimer;

  // Treat takeover (different socket displacing an existing worker) as a first
  // registration so that an `online` metric is emitted for the new connection.
  const isTakeover =
    workersByTargetId.has(targetId) &&
    workersByTargetId.get(targetId)?.socket.id !== socket.id;
  const isFirstRegistration = !workersByTargetId.has(targetId) || isTakeover;
  workersByTargetId.set(targetId, workerContext);
  socketToTarget.set(socket.id, targetId);

  const token = `${relayInstanceId}:${socket.id}:${++ownerGeneration}`;
  workerContext.ownerToken = token;
  targetRegistry
    .register(targetId, {
      instanceId: relayInstanceId,
      socketId: socket.id,
      ownerToken: token,
      organizationId: auth.organizationId,
      userId: auth.userId,
      connectedAt: Date.now(),
    })
    .catch(() => {});

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
        });
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
        for (const { event, payload: eventPayload } of result.emit) {
          socket.emit(event, eventPayload);
        }
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

  // Handle telemetry events — forward to Vercel with rate limiting.
  socket.on("desktop.telemetry", (payload: unknown) => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      pushPendingBuffer(socket, "desktop.telemetry", payload);
      return;
    }

    const loopPerfRateLimitBypass = isLoopPerfTelemetryRateLimitBypass(
      payload,
      targetId
    );
    const rateLimited = loopPerfRateLimitBypass
      ? loopPerfTelemetryRateLimiter.isRateLimited(socket.id)
      : isRateLimited(socket.id);
    if (rateLimited) {
      log.info("desktop.telemetry rate_limited", {
        socketId: socket.id,
        targetId,
        limiter: loopPerfRateLimitBypass ? "loopPerf" : "generic",
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
          gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
          error: err,
        });
      });
  });

  socket.on(
    DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
    (payload: unknown, ack?: (response: DesktopAgentSessionsAck) => void) => {
      const targetId = socketToTarget.get(socket.id);
      if (!targetId) {
        pushPendingBuffer(
          socket,
          DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
          payload,
          ack
        );
        return;
      }

      const worker = workersByTargetId.get(targetId);
      const gatewaySessionId = worker?.gatewaySessionId;

      forwardSocketEvent(
        DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
        payload,
        auth,
        targetId,
        gatewaySessionId,
        socket.id
      )
        .then((result) => {
          ack?.(toDesktopAgentSessionsAck(result.ack));
        })
        .catch((error) => {
          log.error("Failed forwarding desktop.agent-sessions", {
            socketId: socket.id,
            targetId,
            gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
            error,
          });
          ack?.({
            accepted: false,
            reason: DesktopAgentSessionsAckReason.IngestionFailed,
          });
        });
    }
  );

  socket.on(
    DESKTOP_ANALYTICS_SOCKET_EVENT,
    (payload: unknown, ack?: (response: DesktopAnalyticsAck) => void) => {
      const targetId = socketToTarget.get(socket.id);
      if (!targetId) {
        pushPendingBuffer(socket, DESKTOP_ANALYTICS_SOCKET_EVENT, payload, ack);
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
        DESKTOP_ANALYTICS_SOCKET_EVENT,
        enrichedPayload,
        auth,
        targetId,
        gatewaySessionId,
        socket.id
      )
        .then((result) => {
          ack?.(toDesktopAnalyticsAck(result.ack));
        })
        .catch((error) => {
          log.error("Failed forwarding desktop.analytics", {
            socketId: socket.id,
            targetId,
            gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
            error,
          });
          ack?.({
            accepted: false,
            reason: DesktopAnalyticsAckReason.ValidationFailed,
          });
        });
    }
  );

  // Handle presence — forward to Vercel for heartbeat
  socket.on("desktop.presence", async () => {
    const targetId = socketToTarget.get(socket.id);
    if (!targetId) {
      pushPendingBuffer(socket, "desktop.presence");
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
        gatewaySessionIdHash: redactGatewaySessionId(gatewaySessionId),
        error,
      });
    }
  });

  // Handle disconnect — notify Vercel, clean up local state
  socket.on("disconnect", (reason: string) => {
    socketEventQueues.delete(socket.id);
    removeRateLimit(socket.id);
    loopPerfTelemetryRateLimiter.remove(socket.id);

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
      await targetRegistry
        .deregisterAllByInstance(relayInstanceId)
        .catch(() => {});
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

    // Drain the observability buffer within a 5-second wall-clock deadline.
    // log.flush() calls flushToDatadog(), which chains subsequent batches via
    // its .finally() handler, so one awaited call drains all pending entries.
    await Promise.race([
      log.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_FLUSH_DEADLINE_MS).unref?.();
      }),
    ]);
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function tryProxyDispatch(
  targetId: string,
  operation: unknown
): Promise<{ delivered: boolean; reason?: string } | null> {
  const targetMeta = await targetRegistry.lookup(targetId);
  if (!targetMeta || targetMeta.instanceId === relayInstanceId) {
    return null;
  }

  const instanceInfo = await targetRegistry.lookupInstance(
    targetMeta.instanceId
  );
  if (!instanceInfo) {
    return null;
  }

  // SSRF guard: instanceInfo is read from Redis, which must be treated as
  // untrusted input. A poisoned or malformed registry record could otherwise
  // redirect this request — carrying the internal shared secret — to an
  // attacker-controlled host. Only proxy (and attach the secret) when the peer
  // address is an allowed private/VPC target on the expected relay port.
  if (!isAllowedPeerInstance(instanceInfo)) {
    log.warn("Refusing to proxy dispatch to disallowed peer instance", {
      targetId,
      peerInstanceId: targetMeta.instanceId,
      peerPrivateIp: instanceInfo.privateIp,
      peerPort: instanceInfo.port,
    });
    return null;
  }

  try {
    const proxyRes = await fetch(
      `http://${instanceInfo.privateIp}:${instanceInfo.port}/internal/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_API_SECRET as string,
        },
        body: JSON.stringify({ targetId, operation }),
        signal: AbortSignal.timeout(PEER_DISPATCH_TIMEOUT_MS),
      }
    );

    // Treat any non-2xx peer status as not-delivered. Without this, a peer
    // 401/403/500 with a JSON error body would be forwarded verbatim with a 200,
    // and the API caller (which only treats delivered === false as failure)
    // would report the command as successfully dispatched.
    if (!proxyRes.ok) {
      log.warn("Peer instance returned non-2xx for proxied dispatch", {
        targetId,
        peerInstanceId: targetMeta.instanceId,
        status: proxyRes.status,
      });
      return null;
    }

    const proxyResult = (await proxyRes.json()) as {
      delivered: boolean;
      reason?: string;
    };

    // Reject a 2xx response whose body does not match the dispatch envelope,
    // rather than passing an undefined `delivered` through to the caller.
    if (typeof proxyResult?.delivered !== "boolean") {
      log.warn("Peer instance returned a malformed dispatch response", {
        targetId,
        peerInstanceId: targetMeta.instanceId,
      });
      return null;
    }

    if (
      !proxyResult.delivered &&
      proxyResult.reason === "target_not_connected"
    ) {
      targetRegistry
        .deregister(targetId, targetMeta.ownerToken)
        .catch(() => {});
    }

    return proxyResult;
  } catch (error) {
    // A network error, timeout (AbortSignal), or non-JSON body from the peer
    // relay all land here (non-2xx statuses are handled above). We return null
    // and the caller reports "target_not_connected" (the wire contract the
    // Vercel gateway consumes), but log the underlying cause so a
    // down/unreachable/slow peer is distinguishable from a genuinely absent
    // target during debugging.
    log.warn("Proxy dispatch to peer instance failed", {
      targetId,
      peerInstanceId: targetMeta.instanceId,
      peerPrivateIp: instanceInfo.privateIp,
      peerPort: instanceInfo.port,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function handleInternalDispatch(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!validateSecret(req.headers["x-internal-secret"])) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  // The timing-safe shared secret (validateSecret, above) is the security
  // boundary for this endpoint. The CIDR allowlist is optional defense-in-depth
  // for deployments that want to additionally restrict source IPs to the VPC.
  // When unset, the secret alone authorizes — a localhost-only fallback would
  // be wrong here, since legitimate cross-instance proxy traffic originates
  // from peer relays' private IPs, never loopback.
  if (RELAY_INTERNAL_ALLOWED_IPS.length > 0) {
    const sourceIp = req.socket.remoteAddress ?? "";
    const allowed = RELAY_INTERNAL_ALLOWED_IPS.some((cidr) =>
      isAddressInCidr(sourceIp, cidr)
    );
    if (!allowed) {
      jsonResponse(res, 403, { error: "Forbidden" });
      return;
    }
  }

  const payload = await parseDispatchBody(req, res);
  if (!payload) {
    return;
  }

  const { targetId, operation } = payload;
  const worker = workersByTargetId.get(targetId);
  if (!worker) {
    jsonResponse(res, 200, {
      delivered: false,
      reason: "target_not_connected",
    });
    return;
  }

  worker.socket.emit("desktop.command", operation);
  jsonResponse(res, 200, { delivered: true });
}

const IPV6_MAPPED_RE = /^::ffff:/;

export function isAddressInCidr(address: string, cidr: string): boolean {
  const [subnet, bits] = cidr.split("/");
  if (!(subnet && bits)) {
    return address === cidr;
  }
  const prefixLen = Number(bits);
  // Fail closed on malformed or out-of-range prefixes (e.g. "/foo", "/-1",
  // "/40"). A malformed allowlist entry must never match every address.
  // Mirrors the MCP counterpart in apps/mcp/src/index.ts.
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    return false;
  }
  // "/0" legitimately matches all addresses. Handle it explicitly: the mask
  // computation below would shift by 32, which JS evaluates as a shift by 0
  // (1 << 32 === 1), producing a full mask instead of an empty one.
  if (prefixLen === 0) {
    return true;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: IP address mask computation requires bitwise ops
  const mask = ~((1 << (32 - prefixLen)) - 1) >>> 0;
  const ipNum = ipToNumber(address.replace(IPV6_MAPPED_RE, ""));
  const subnetNum = ipToNumber(subnet);
  // biome-ignore lint/suspicious/noBitwiseOperators: IP subnet matching requires bitwise AND
  return (ipNum & mask) === (subnetNum & mask);
}

function ipToNumber(ip: string): number {
  let result = 0;
  for (const octet of ip.split(".")) {
    // biome-ignore lint/suspicious/noBitwiseOperators: packing IPv4 octets into a 32-bit integer
    result = (result << 8) + Number(octet);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: unsigned 32-bit conversion
  return result >>> 0;
}

// Egress allowlist for cross-instance dispatch. The peer address comes from the
// Redis registry, so it is untrusted: validate it before sending the internal
// secret. The port must match this deployment's relay port (every relay task
// listens on the same port), and the IP must be either inside the configured
// CIDR allowlist or — when none is configured — an RFC1918 private address.
export function isAllowedPeerInstance(info: InstanceInfo): boolean {
  if (typeof info.privateIp !== "string" || !Number.isInteger(info.port)) {
    return false;
  }
  if (info.port !== RELAY_PORT) {
    return false;
  }
  if (RELAY_INTERNAL_ALLOWED_IPS.length > 0) {
    return RELAY_INTERNAL_ALLOWED_IPS.some((cidr) =>
      isAddressInCidr(info.privateIp, cidr)
    );
  }
  return isRoutablePrivateIpv4(info.privateIp);
}

// Pure ownership decision: is the live local socket still the registry's owner
// for this target? In Redis mode the shared registry is authoritative; a target
// that re-registered on another instance leaves this instance holding a stale
// socket that must not receive dispatches. A null registry entry (in-memory
// miss, degraded Redis, or TTL lapse while connected) trusts the live socket.
export function isCurrentRegistryOwner(
  registered: TargetMetadata | null,
  worker: Pick<WorkerContext, "ownerToken">,
  instanceId: string
): boolean {
  if (!registered) {
    return true;
  }
  return (
    registered.instanceId === instanceId &&
    registered.ownerToken === worker.ownerToken
  );
}

async function isLocalWorkerCurrentOwner(
  targetId: string,
  worker: WorkerContext
): Promise<boolean> {
  const registered = await targetRegistry.lookup(targetId);
  return isCurrentRegistryOwner(registered, worker, relayInstanceId);
}

if (process.env.NODE_ENV !== "test") {
  startRelayServer().catch((error) => {
    log.error("Failed to start relay server", { error });
    process.exit(1);
  });

  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);
}
