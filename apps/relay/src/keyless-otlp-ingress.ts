/**
 * Keyless telemetry-only OTLP ingress (FEA-1989 / PRD-481 C1).
 *
 * Mounts a dedicated, UNAUTHENTICATED Socket.IO `/telemetry` namespace that is
 * fully isolated from the authenticated `/desktop-gateway` command/DB-sync
 * namespace. A keyless client:
 *   1. emits `telemetry.session.create` (handshake) → gets a short-lived,
 *      in-memory session bound to its self-asserted `appInstallationId`;
 *   2. emits `telemetry.otlp.export` events carrying OTLP protobuf bytes, which
 *      the relay forwards **opaque** (no protobuf decode) to a single, fixed,
 *      operator-configured OTel Collector origin at `/v1/{signal}`.
 *
 * Security posture (see PLN-1120 §Security/Abuse):
 *  - The relay is NOT an open proxy: the destination is a single startup-
 *    validated origin from `RELAY_OTLP_COLLECTOR_URL`; no request field ever
 *    influences the upstream host.
 *  - No DB-sync / command / dispatch capability is reachable here — this module
 *    never calls `forwardSocketEvent`, registers a worker, or touches the
 *    target registry.
 *  - Cheap guards (session lookup, rate limits, envelope shape/size) run before
 *    any collector request. There is no protobuf decode on this unauthenticated
 *    path; payload-content validation is the Collector's responsibility.
 */

import { randomUUID } from "node:crypto";
import {
  KEYLESS_TELEMETRY_COLLECTOR_DIAGNOSTIC_MAX_BYTES,
  KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS,
  KEYLESS_TELEMETRY_CONTENT_TYPE,
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_INSTALLATION_RATE_LIMIT_PER_MINUTE,
  KEYLESS_TELEMETRY_IP_RATE_LIMIT_PER_MINUTE,
  KEYLESS_TELEMETRY_MAX_ACTIVE_SESSIONS,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_NAMESPACE,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  KEYLESS_TELEMETRY_SESSION_RATE_LIMIT_PER_MINUTE,
  KEYLESS_TELEMETRY_SESSION_TTL_MS,
  type KeylessTelemetryExportAck,
  KeylessTelemetryRejectionReason,
  type KeylessTelemetrySessionAck,
  KeylessTelemetrySignal,
  keylessTelemetrySignalPath,
  validateKeylessTelemetryEnvelope,
  validateKeylessTelemetrySessionRequest,
} from "@closedloop-ai/shared-platform/keyless-telemetry";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { createConcurrencyLimiter } from "./concurrency-limiter";
import { createRateLimiter } from "./rate-limiter";

/** Per-connection cap on concurrent live sessions (one legit client needs ~1). */
const MAX_SESSIONS_PER_SOCKET = 8;

/**
 * Process-wide ceiling on concurrently in-flight relay → collector proxy
 * requests (FEA-1994 back-pressure core). Bounds outbound sockets, pending
 * promises, and retained request bodies (≤512 KB each) regardless of fleet
 * size; exports offered past this ceiling are load-shed with a retryable
 * `rate_limited` ack rather than queued.
 */
const DEFAULT_MAX_INFLIGHT_EXPORTS = 256;

/**
 * Ceiling on concurrent live `/telemetry` connections (FEA-1994 connection
 * model). Fences the keyless namespace's connection budget so a keyless
 * connection storm cannot starve the authenticated `/desktop-gateway` namespace
 * — both share one Socket.IO engine / Node HTTP server. Headroom over the
 * 1,400+ fleet target.
 */
const DEFAULT_MAX_CONNECTIONS = 3000;

/**
 * Number of trusted reverse-proxy hops in front of the relay (FEA-1994 IP
 * tier). `0` (default) uses the immediate TCP peer — correct for direct
 * connections. Behind the ALB set `1` so the per-IP rate-limit key is the real
 * client IP from `X-Forwarded-For` instead of the shared LB address (otherwise
 * the whole fleet collapses into one per-IP bucket at fleet scale).
 */
const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/** Minimal session-id extraction schema (relay-internal). */
const sessionIdSchema = z.object({
  sessionId: z.string().min(1).max(256),
});

/**
 * Adapter from the global `fetch` to the narrower {@link FetchImpl} shape used
 * by the collector proxy. A `Response` structurally satisfies the return shape
 * (`ok`, `status`, `text()`, and a `body` with `cancel()`), so no return cast
 * is needed. The single `as BodyInit` localizes the one real type friction: a
 * `Uint8Array` is a valid runtime fetch body, but TS's `BodyInit` is stricter
 * about the backing buffer type. Far cleaner than casting the whole function.
 */
function defaultFetch(
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  }
): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body?: { cancel: () => Promise<void> } | null;
}> {
  return fetch(input, { ...init, body: init.body as BodyInit });
}

type FetchImpl = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body?: { cancel: () => Promise<void> } | null;
}>;

export type KeylessTelemetryConfig = {
  /** Raw `RELAY_OTLP_COLLECTOR_URL`; null/empty/invalid → fail-closed exports. */
  collectorUrl: string | null | undefined;
  /** `RELAY_OTLP_ALLOW_PRIVATE_COLLECTOR_URL === "true"` (test/dev only). */
  allowPrivateCollector: boolean;
  /** Whether `NODE_ENV === "production"`. */
  isProduction: boolean;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Overrides for fast, deterministic tests. */
  sessionTtlMs?: number;
  sweepIntervalMs?: number;
  maxActiveSessions?: number;
  sessionRateLimitPerMinute?: number;
  installRateLimitPerMinute?: number;
  ipRateLimitPerMinute?: number;
  /** Max concurrently in-flight collector proxy requests (back-pressure). */
  maxInflightExports?: number;
  /** Max concurrent live `/telemetry` connections (connection-budget fence). */
  maxConnections?: number;
  /** Trusted reverse-proxy hops for `X-Forwarded-For` client-IP derivation. */
  trustedProxyHops?: number;
};

export type KeylessTelemetryNamespaceHandle = {
  /** Live session count (in-memory). */
  activeSessions: () => number;
  /** Live `/telemetry` connection count (in-memory). */
  activeConnections: () => number;
  /** Currently in-flight collector proxy requests. */
  inFlightExports: () => number;
  /** Stop the expiry sweep timer (tests / shutdown). */
  close: () => void;
};

type Session = {
  appInstallationId: string;
  expiresAt: number;
};

type ResolvedCollector = { ok: true; origin: string } | { ok: false };

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Extract a string `sessionId` from an untyped export payload, else null. */
function extractSessionId(payload: unknown): string | null {
  const result = sessionIdSchema.safeParse(payload);
  return result.success ? result.data.sessionId : null;
}

/** RFC1918 private, loopback, link-local, or unspecified host literals. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  // `URL.hostname` returns IPv6 literals BRACKETED (e.g. "[::1]"). Strip the
  // brackets and apply the IPv6-private prefix checks ONLY to a real IPv6
  // literal — never to a hostname, so e.g. "fcollector.internal" is not
  // false-flagged as a ULA. `::ffff:*` catches IPv4-mapped loopback/RFC1918.
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    return (
      v6 === "::1" || // loopback
      v6 === "::" || // unspecified
      v6.startsWith("fc") || // ULA fc00::/7
      v6.startsWith("fd") ||
      v6.startsWith("fe80") || // link-local fe80::/10
      v6.startsWith("::ffff:") // IPv4-mapped
    );
  }
  const ipv4 = IPV4_REGEX.exec(host);
  if (!ipv4) {
    // A non-IP hostname (e.g. collector.internal) is operator-fixed and not
    // client-derived, so it is allowed; we cannot resolve it here.
    return false;
  }
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    return true; // malformed → treat as disallowed
  }
  const [a, b] = octets;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  return false;
}

/**
 * Resolve the fixed collector origin once at startup. Allows only absolute
 * http/https URLs, strips path/query/hash, and rejects private/loopback hosts
 * in production unless explicitly opted in. The destination is never derived
 * from request input.
 */
export function resolveCollectorOrigin(
  config: Pick<
    KeylessTelemetryConfig,
    "collectorUrl" | "allowPrivateCollector" | "isProduction"
  >
): ResolvedCollector {
  const raw = config.collectorUrl?.trim();
  if (!raw) {
    return { ok: false };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false };
  }
  if (
    config.isProduction &&
    !config.allowPrivateCollector &&
    isPrivateOrLoopbackHost(url.hostname)
  ) {
    return { ok: false };
  }
  // Strip path/query/hash — only the origin is honored.
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

async function readCappedText(res: {
  text: () => Promise<string>;
}): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, KEYLESS_TELEMETRY_COLLECTOR_DIAGNOSTIC_MAX_BYTES);
  } catch {
    return "";
  }
}

async function proxyToCollector(
  origin: string,
  signal: KeylessTelemetrySignal,
  body: Uint8Array,
  fetchImpl: FetchImpl
): Promise<KeylessTelemetryExportAck> {
  const url = `${origin}${keylessTelemetrySignalPath(signal)}`;
  let res: Awaited<ReturnType<FetchImpl>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      // Use the validated constant, never a client-echoed content type.
      headers: { "Content-Type": KEYLESS_TELEMETRY_CONTENT_TYPE },
      body,
      signal: AbortSignal.timeout(KEYLESS_TELEMETRY_COLLECTOR_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : undefined;
    if (name === "TimeoutError") {
      return {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.RequestTimeout,
        retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
      };
    }
    return {
      accepted: false,
      reason: KeylessTelemetryRejectionReason.CollectorUnavailable,
      retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
    };
  }

  if (res.ok) {
    // Free the connection without reading the (irrelevant) success body.
    await res.body?.cancel().catch(() => undefined);
    return { accepted: true };
  }

  // Bounded diagnostic capture — never forwarded to the client.
  const diagnostic = await readCappedText(res);
  if (res.status >= 400 && res.status < 500) {
    log.warn("keyless telemetry: collector rejected payload", {
      status: res.status,
      diagnosticBytes: diagnostic.length,
    });
    return {
      accepted: false,
      reason: KeylessTelemetryRejectionReason.OtlpRejected,
    };
  }
  log.warn("keyless telemetry: collector unavailable", {
    status: res.status,
    diagnosticBytes: diagnostic.length,
  });
  return {
    accepted: false,
    reason: KeylessTelemetryRejectionReason.CollectorUnavailable,
    retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  };
}

function ack<T>(callback: unknown, response: T): void {
  if (typeof callback === "function") {
    (callback as (value: T) => void)(response);
  }
}

/** The canonical retryable rate-limit rejection ack. */
function rateLimited(): KeylessTelemetryExportAck {
  return {
    accepted: false,
    reason: KeylessTelemetryRejectionReason.RateLimited,
    retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  };
}

/**
 * Fleet-capacity metrics (FEA-1994), emitted through the generic telemetry-
 * metric pipeline so the Datadog log-to-metric processor and the load test can
 * observe shedding/rejection without a `@repo/observability` schema change.
 */
type KeylessCapacityMetric = {
  metric:
    | "keyless_telemetry_connection_rejected"
    | "keyless_telemetry_export_shed";
  reason: "at_connection_capacity" | "backpressure";
  count: 1;
};

function emitCapacityMetric(metric: KeylessCapacityMetric): void {
  emitTelemetryMetric(metric);
}

/** Minimal handshake shape needed to derive the rate-limit client IP. */
type HandshakeLike = {
  address?: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Resolve the per-IP rate-limit key for a connection (FEA-1994).
 *
 * With `trustedProxyHops <= 0` the immediate TCP peer is used — the only
 * forge-proof source for a direct connection. With `n > 0` trusted reverse
 * proxies in front (e.g. the ALB at `n = 1`), the real client IP is the entry
 * `n` from the right of `X-Forwarded-For` (`parts[len - n]`), since each proxy
 * appends the address that connected to it. If the header is absent or has
 * fewer than `n` entries (misconfiguration or a spoof that omits the expected
 * chain), this falls back to the immediate peer rather than trusting a
 * client-supplied value.
 */
export function deriveClientIp(
  handshake: HandshakeLike,
  trustedProxyHops: number
): string {
  const peer = handshake.address || "unknown";
  if (trustedProxyHops <= 0) {
    return peer;
  }
  const raw = handshake.headers["x-forwarded-for"];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  if (!joined) {
    return peer;
  }
  const parts = joined
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const index = parts.length - trustedProxyHops;
  if (index < 0 || index >= parts.length) {
    return peer;
  }
  return parts[index] || peer;
}

export function registerKeylessTelemetryNamespace(
  io: Server,
  config: KeylessTelemetryConfig
): KeylessTelemetryNamespaceHandle {
  const fetchImpl = config.fetchImpl ?? defaultFetch;
  const sessionTtlMs = config.sessionTtlMs ?? KEYLESS_TELEMETRY_SESSION_TTL_MS;
  const maxActiveSessions =
    config.maxActiveSessions ?? KEYLESS_TELEMETRY_MAX_ACTIVE_SESSIONS;
  const maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const trustedProxyHops = Math.max(
    0,
    config.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS
  );
  const collectorLimiter = createConcurrencyLimiter(
    config.maxInflightExports ?? DEFAULT_MAX_INFLIGHT_EXPORTS
  );

  // Live `/telemetry` connection count, fenced at `maxConnections` so a keyless
  // connection storm cannot exhaust the engine budget the authenticated
  // namespace shares.
  let activeConnections = 0;

  const collector = resolveCollectorOrigin(config);
  if (!collector.ok) {
    log.warn(
      "keyless telemetry: RELAY_OTLP_COLLECTOR_URL unset/invalid — ingress mounted but exports fail closed (collector_unavailable)"
    );
  }

  const sessions = new Map<string, Session>();
  const ipLimiter = createRateLimiter(
    config.ipRateLimitPerMinute ?? KEYLESS_TELEMETRY_IP_RATE_LIMIT_PER_MINUTE
  );
  const sessionLimiter = createRateLimiter(
    config.sessionRateLimitPerMinute ??
      KEYLESS_TELEMETRY_SESSION_RATE_LIMIT_PER_MINUTE
  );
  const installLimiter = createRateLimiter(
    config.installRateLimitPerMinute ??
      KEYLESS_TELEMETRY_INSTALLATION_RATE_LIMIT_PER_MINUTE
  );

  function dropSession(sessionId: string): void {
    sessions.delete(sessionId);
    sessionLimiter.remove(sessionId);
  }

  const namespace = io.of(KEYLESS_TELEMETRY_NAMESPACE);

  namespace.on("connection", (socket: Socket) => {
    // Connection-budget fence (FEA-1994): reject past the cap BEFORE wiring any
    // handlers or incrementing, so the keyless namespace cannot exhaust the
    // engine/file-descriptor budget the authenticated namespace shares.
    if (activeConnections >= maxConnections) {
      emitCapacityMetric({
        metric: "keyless_telemetry_connection_rejected",
        reason: "at_connection_capacity",
        count: 1,
      });
      log.warn("keyless telemetry: at connection capacity, rejecting socket", {
        activeConnections,
        maxConnections,
      });
      // `disconnect()` (close=false) tears down ONLY this `/telemetry` namespace
      // socket. Never `disconnect(true)`: the contract lets a client multiplex
      // `/telemetry` over the same Engine.IO connection as the authenticated
      // `/desktop-gateway` namespace, and closing the underlying transport would
      // kill that authenticated session — the exact degradation this fence
      // exists to prevent.
      socket.disconnect();
      return;
    }
    activeConnections += 1;

    // Per-IP rate-limit key. With `trustedProxyHops > 0` (e.g. behind the ALB)
    // this is the real client IP from X-Forwarded-For so each install gets its
    // own per-IP bucket; otherwise it is the immediate TCP peer (FEA-1994).
    const ip = deriveClientIp(socket.handshake, trustedProxyHops);
    const ownedSessions = new Set<string>();

    socket.on(KEYLESS_TELEMETRY_HANDSHAKE_EVENT, (payload, callback) => {
      if (ipLimiter.isRateLimited(ip)) {
        ack<KeylessTelemetrySessionAck>(callback, {
          accepted: false,
          reason: KeylessTelemetryRejectionReason.RateLimited,
        });
        return;
      }

      const validation = validateKeylessTelemetrySessionRequest(payload);
      if (!validation.ok) {
        ack<KeylessTelemetrySessionAck>(callback, {
          accepted: false,
          reason: validation.reason,
        });
        return;
      }

      // Prune sessions this socket created that have since been dropped
      // (swept/expired), then cap concurrent live sessions per connection.
      for (const id of ownedSessions) {
        if (!sessions.has(id)) {
          ownedSessions.delete(id);
        }
      }
      if (ownedSessions.size >= MAX_SESSIONS_PER_SOCKET) {
        ack<KeylessTelemetrySessionAck>(callback, {
          accepted: false,
          reason: KeylessTelemetryRejectionReason.AtCapacity,
        });
        return;
      }

      if (sessions.size >= maxActiveSessions) {
        log.warn("keyless telemetry: at capacity, rejecting session", {
          activeSessions: sessions.size,
        });
        ack<KeylessTelemetrySessionAck>(callback, {
          accepted: false,
          reason: KeylessTelemetryRejectionReason.AtCapacity,
        });
        return;
      }

      const sessionId = randomUUID();
      sessions.set(sessionId, {
        appInstallationId: validation.request.appInstallationId,
        expiresAt: Date.now() + sessionTtlMs,
      });
      ownedSessions.add(sessionId);

      ack<KeylessTelemetrySessionAck>(callback, {
        accepted: true,
        sessionId,
        exportEvent: KEYLESS_TELEMETRY_EXPORT_EVENT,
        acceptedSignals: Object.values(KeylessTelemetrySignal),
        maxBodyBytes: KEYLESS_TELEMETRY_MAX_BODY_BYTES,
        ttlMs: sessionTtlMs,
      });
    });

    // Resolve session, enforce rate limits + envelope shape, then proxy. Kept
    // as a flat early-return helper so the socket handler stays trivial.
    // Session resolution + rate limiting, split out to keep handleExport flat.
    const resolveExportSession = (
      payload: unknown
    ):
      | { ok: true; session: Session }
      | { ok: false; ack: KeylessTelemetryExportAck } => {
      // IP limit FIRST so a connected socket spamming garbage/invalid-session
      // events is bounded at the outermost gate (cheapest possible rejection).
      if (ipLimiter.isRateLimited(ip)) {
        return { ok: false, ack: rateLimited() };
      }

      const sessionId = extractSessionId(payload);
      if (!sessionId) {
        return {
          ok: false,
          ack: {
            accepted: false,
            reason: KeylessTelemetryRejectionReason.InvalidRequest,
          },
        };
      }

      const session = sessions.get(sessionId);
      if (!session || session.expiresAt <= Date.now()) {
        if (session) {
          dropSession(sessionId);
          ownedSessions.delete(sessionId);
        }
        return {
          ok: false,
          ack: {
            accepted: false,
            reason: KeylessTelemetryRejectionReason.InvalidSession,
          },
        };
      }

      // Per-session + per-install limits (after identity is established).
      if (
        sessionLimiter.isRateLimited(sessionId) ||
        installLimiter.isRateLimited(session.appInstallationId)
      ) {
        return { ok: false, ack: rateLimited() };
      }

      return { ok: true, session };
    };

    const handleExport = async (
      payload: unknown
    ): Promise<KeylessTelemetryExportAck> => {
      const resolved = resolveExportSession(payload);
      if (!resolved.ok) {
        return resolved.ack;
      }

      const envelope = validateKeylessTelemetryEnvelope(payload);
      if (!envelope.ok) {
        return { accepted: false, reason: envelope.reason };
      }

      if (!collector.ok) {
        return {
          accepted: false,
          reason: KeylessTelemetryRejectionReason.CollectorUnavailable,
          retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
        };
      }

      // Back-pressure (FEA-1994): bound concurrently in-flight collector
      // requests across the whole namespace. Past the ceiling, load-shed with a
      // retryable `rate_limited` ack — never queue — so aggregate in-flight work
      // (and thus memory + event-loop time shared with the authenticated path)
      // stays bounded under a fleet-scale spike.
      if (!collectorLimiter.tryAcquire()) {
        emitCapacityMetric({
          metric: "keyless_telemetry_export_shed",
          reason: "backpressure",
          count: 1,
        });
        return rateLimited();
      }
      try {
        return await proxyToCollector(
          collector.origin,
          envelope.envelope.signal,
          envelope.envelope.body,
          fetchImpl
        );
      } finally {
        collectorLimiter.release();
      }
    };

    socket.on(KEYLESS_TELEMETRY_EXPORT_EVENT, (payload, callback) => {
      handleExport(payload)
        .then((response) => ack<KeylessTelemetryExportAck>(callback, response))
        .catch((error) => {
          log.error("keyless telemetry: proxy failed unexpectedly", {
            error: error instanceof Error ? error.message : "unknown",
          });
          ack<KeylessTelemetryExportAck>(callback, {
            accepted: false,
            reason: KeylessTelemetryRejectionReason.CollectorUnavailable,
            retryAfterSeconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
          });
        });
    });

    socket.on("disconnect", () => {
      activeConnections = Math.max(0, activeConnections - 1);
      for (const sessionId of ownedSessions) {
        dropSession(sessionId);
      }
      ownedSessions.clear();
    });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= now) {
        dropSession(sessionId);
      }
    }
    // Evict idle rate-limiter keys. The IP and install limiters are keyed by
    // client-influenced values on an unauthenticated endpoint, so without this
    // their maps would grow without bound (memory-exhaustion DoS).
    ipLimiter.prune();
    sessionLimiter.prune();
    installLimiter.prune();
  }, config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  // Do not keep the event loop alive solely for the sweep.
  sweep.unref?.();

  return {
    activeSessions: () => sessions.size,
    activeConnections: () => activeConnections,
    inFlightExports: () => collectorLimiter.inFlight(),
    close: () => clearInterval(sweep),
  };
}
