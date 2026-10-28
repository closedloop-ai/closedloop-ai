import type { Server as HttpServer } from "node:http";
import { log } from "@repo/observability/log";
import { REALTIME_SOCKET_PATH } from "@repo/realtime-contract/protocol";
import type { RealtimeTokenClaims } from "@repo/realtime-contract/token";
import { type DefaultEventsMap, Server, type Socket } from "socket.io";
import { maxPacketBytesAcrossClasses } from "../classes/registry";

export const PING_INTERVAL_MS = 25_000;
export const DEFAULT_PING_TIMEOUT_MS = 60_000;
/** ISS-8698: one late pong must not end a live connection. */
export const MIN_PING_TIMEOUT_MS = 2 * PING_INTERVAL_MS;

export const PING_TIMEOUT_CLAMPED_EVENT = "realtime.ping_timeout_clamped";

export type RealtimeSocketData = {
  claims: RealtimeTokenClaims;
  clientVersion: string;
};

export type RealtimeServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;

export type RealtimeSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  RealtimeSocketData
>;

export type RealtimeSocketServerOptions = {
  /** `REALTIME_PING_TIMEOUT_MS`; unset uses {@link DEFAULT_PING_TIMEOUT_MS}. */
  pingTimeoutMs: number | undefined;
  allowedOrigins: readonly string[];
};

/**
 * Every socket.io option the service sets, in one place (PLN-2104 decision 1).
 * `connectionStateRecovery` is deliberately absent, which leaves it off:
 * recovery replays missed packets, and replay was removed by ruling on
 * 2026-09-24, so a reconnect is always a fresh session.
 */
export function createRealtimeSocketServer(
  httpServer: HttpServer,
  options: RealtimeSocketServerOptions
): RealtimeServer {
  const { allowedOrigins } = options;
  return new Server(httpServer, {
    // The load balancer routes one port; socket.io takes this path on it
    // (PLN-2104 decision 4).
    path: REALTIME_SOCKET_PATH,
    serveClient: false,
    transports: ["websocket"],
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: resolvePingTimeoutMs(options.pingTimeoutMs),
    maxHttpBufferSize: maxPacketBytesAcrossClasses(),
    cors: {
      origin: (origin, callback) =>
        callback(null, isAllowedOrigin(origin, allowedOrigins)),
    },
    // Browsers apply no CORS to a WebSocket upgrade, so `cors` alone never
    // refuses one; the origin is checked again where the engine admits it.
    // The refused client sees a bare transport close, so the log is the only
    // trace of a missing or wrong REALTIME_ALLOWED_ORIGINS.
    allowRequest: (req, callback) => {
      const { origin } = req.headers;
      const allowed = isAllowedOrigin(origin, allowedOrigins);
      if (!allowed) {
        log.warn("Realtime refused a browser origin", {
          event: ORIGIN_REFUSED_EVENT,
          origin: origin?.slice(0, MAX_LOGGED_ORIGIN_LENGTH),
        });
      }
      callback(null, allowed);
    },
  });
}

/**
 * A value outside [{@link MIN_PING_TIMEOUT_MS}, {@link MAX_PING_TIMEOUT_MS}]
 * is clamped to the nearer bound, with a warning.
 */
export function resolvePingTimeoutMs(configuredMs: number | undefined): number {
  const value = configuredMs ?? DEFAULT_PING_TIMEOUT_MS;
  const clamped = Math.min(
    Math.max(value, MIN_PING_TIMEOUT_MS),
    MAX_PING_TIMEOUT_MS
  );
  if (clamped === value) {
    return value;
  }
  log.warn(
    `REALTIME_PING_TIMEOUT_MS is outside ${MIN_PING_TIMEOUT_MS}..${MAX_PING_TIMEOUT_MS}ms, using ${clamped}ms`,
    {
      event: PING_TIMEOUT_CLAMPED_EVENT,
      value,
      floorMs: MIN_PING_TIMEOUT_MS,
      ceilingMs: MAX_PING_TIMEOUT_MS,
    }
  );
  return clamped;
}

/**
 * Desktop's main process sends no `Origin` and is allowed, as on the relay.
 * Any request that carries one must be on the allow-list exactly.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[]
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

/**
 * Node's timer ceiling, less the interval: engine.io arms `pingInterval +
 * pingTimeout` on one timer for a protocol-3 client, and a delay past the
 * ceiling fires after 1ms.
 */
export const MAX_PING_TIMEOUT_MS = 2_147_483_647 - PING_INTERVAL_MS;

export const ORIGIN_REFUSED_EVENT = "realtime.origin_refused";

/** The header is client-chosen; a scheme, host and port fit well inside this. */
const MAX_LOGGED_ORIGIN_LENGTH = 256;
