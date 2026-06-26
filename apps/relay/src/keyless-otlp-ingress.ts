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
import type { Server } from "socket.io";
import { z } from "zod";
import { createRateLimiter } from "./rate-limiter";

/** Per-connection cap on concurrent live sessions (one legit client needs ~1). */
const MAX_SESSIONS_PER_SOCKET = 8;

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
};

export type KeylessTelemetryNamespaceHandle = {
  /** Live session count (in-memory). */
  activeSessions: () => number;
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

export function registerKeylessTelemetryNamespace(
  io: Server,
  config: KeylessTelemetryConfig
): KeylessTelemetryNamespaceHandle {
  const fetchImpl = config.fetchImpl ?? defaultFetch;
  const sessionTtlMs = config.sessionTtlMs ?? KEYLESS_TELEMETRY_SESSION_TTL_MS;
  const maxActiveSessions =
    config.maxActiveSessions ?? KEYLESS_TELEMETRY_MAX_ACTIVE_SESSIONS;

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

  namespace.on("connection", (socket) => {
    // Immediate TCP peer. Behind a proxy/LB this is the proxy's address, so the
    // IP tier degrades to a coarse global bound there; the per-session and
    // per-install tiers are the primary per-client bounds. A trusted-proxy
    // X-Forwarded-For tier is deferred to FEA-1994 (capacity/back-pressure).
    const ip = socket.handshake.address || "unknown";
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

      return await proxyToCollector(
        collector.origin,
        envelope.envelope.signal,
        envelope.envelope.body,
        fetchImpl
      );
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
    close: () => clearInterval(sweep),
  };
}
