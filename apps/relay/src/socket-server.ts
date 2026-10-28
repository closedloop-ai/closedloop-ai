import type { Server as HttpServer } from "node:http";
import { log } from "@repo/observability/log";
import { Server } from "socket.io";
import { parsePositiveEnvMs } from "./parse-env.js";

/**
 * @file socket-server.ts
 * @description ISS-8698: how long the relay waits before declaring a desktop
 * peer dead.
 *
 * These were socket.io's implicit defaults (`pingInterval` 25s, `pingTimeout`
 * 20s) until the 2026-08-31 incident, and nothing at the `new Server(...)` call
 * site said 45 seconds had ever been a decision. Under those defaults the server
 * pings every 25s and disconnects if that one ping's pong has not arrived 20s
 * later, so a peer whose pong is merely LATE — not absent — is dropped 45s into
 * the connection.
 *
 * One customer's client did exactly that, repeatedly. Relay logs over 12h showed
 * 36 connections whose durations quantized to 45 + 25n seconds — 44.7s, 44.7s,
 * 44.5s, 69.8s, 94.8s, 128.8s, 184.5s — where n is the number of pings that were
 * answered before one was not. It held a connection 47.4% of that window and
 * ~5% during the worst stretch, while healthy clients on the same relay in the
 * same seconds heartbeated normally. The path to that one client was losing
 * ping/pong traffic intermittently, and a single loss was fatal.
 *
 * WHY A LONGER TIMEOUT IS EXPECTED TO HELP, AND WHY THAT IS A HYPOTHESIS.
 * The loss is intermittent, not total: the 69.8s / 94.8s / 128.8s / 184.5s
 * sessions each had pongs get through, and after 15:34 UTC the same client held
 * sessions of 5 to 64 minutes. Widening the window each ping gets should convert
 * a large share of the 45-second sessions into long ones. It cannot help a peer
 * whose pongs are lost for the whole window, and it is not a substitute for
 * ISS-8691 (which makes session sync stop caring whether the socket is up) —
 * that one shipped, but only reaches a client through a desktop release.
 *
 * THE COST, WHICH IS FLEET-WIDE AND PAID BY EVERY CLIENT.
 * Dead-peer detection slows from at most 45s to at most
 * `PING_INTERVAL_MS + PING_TIMEOUT_MS`. For that extra window a genuinely dead
 * desktop keeps a registered target and `compute_targets.is_online` stays true,
 * so the web UI can offer a machine that is gone, and a command dispatched to it
 * fails later than it would have. That is the trade being made deliberately
 * here: a longer lie about a dead peer, in exchange for not severing live ones.
 * Presence is not blind for the whole window — the heartbeat's own
 * `HEARTBEAT_DEGRADED_THRESHOLD_MS` timer (60s by default) still emits
 * `ConnectionState.Degraded` on schedule. It is `is_online` specifically, which
 * clears only in the socket `disconnect` handler, that goes stale for longer.
 *
 * That cost is symmetric, and the client half is the easy one to miss.
 * engine.io-client reads the server's advertised `pingInterval`/`pingTimeout`
 * out of the handshake and arms its own dead-SERVER timer at
 * `pingInterval + pingTimeout` (engine.io-client 6.6.5, `_resetPingTimeout` in
 * `build/cjs/socket.js`), so a desktop's detection of a dead RELAY moves from
 * 45s to 85s in the same change. Nothing inverts — `cloud-socket.ts` retries
 * 1s later and its 120s recovery window still covers the wider gap — but after
 * a non-graceful relay restart every client sits on a corpse socket for an
 * extra 40s before it begins reconnecting.
 */

/** How often the server pings a connected peer. Socket.io's default, made explicit. */
export const PING_INTERVAL_MS = 25_000;

/**
 * The deployed pong deadline, raised from socket.io's 20s default so a late
 * pong does not end an otherwise live connection.
 */
export const DEFAULT_PING_TIMEOUT_MS = 60_000;

/**
 * The property that makes this policy meaningful rather than a pair of numbers:
 * the window a pong may arrive in must span more than one ping interval, or a
 * single lost pong is still fatal and the change buys nothing.
 *
 * Enforced as a floor on the override below rather than only asserted in a
 * test, because `RELAY_PING_TIMEOUT_MS` is set by an operator at deploy time,
 * where no test can see the value and a rollback past this point would silently
 * restore the incident condition.
 */
export const MIN_PING_TIMEOUT_MS = 2 * PING_INTERVAL_MS;

/**
 * How long a peer has to answer one ping before it is declared dead.
 *
 * `RELAY_PING_TIMEOUT_MS` exists because 60s is a hypothesis whose acceptance
 * check is re-measuring connection durations after this deploys: if it lands
 * too low to help, or high enough that presence rots, correcting it is an env
 * change rather than another relay build. Values below
 * {@link MIN_PING_TIMEOUT_MS} are raised to it.
 */
export const PING_TIMEOUT_MS = resolvePingTimeoutMs();

const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost:\d+$/;

/**
 * Socket.IO CORS origin guard. Desktop workers connect via Node
 * socket.io-client and send no browser Origin header, so those are always
 * allowed. Any request that carries an Origin is a browser — none are expected
 * here — so it is rejected (localhost permitted in non-production for local
 * tooling). This keeps the credentialed `/desktop-gateway` namespace closed to
 * arbitrary sites even if the websocket-only transport is ever broadened.
 */
export function isAllowedSocketOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  return (
    process.env.NODE_ENV !== "production" && LOCALHOST_ORIGIN_REGEX.test(origin)
  );
}

/**
 * The relay's socket.io server, constructed in one place so the transport pin,
 * the ping policy above, and the origin guard are read together rather than
 * three unexplained keys in an options literal.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  return new Server(httpServer, {
    transports: ["websocket"],
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    cors: {
      origin: (origin, callback) =>
        callback(null, isAllowedSocketOrigin(origin)),
      credentials: true,
    },
  });
}

/**
 * Reads the operator override and holds it to {@link MIN_PING_TIMEOUT_MS}. A
 * clamped value is warned about rather than applied silently, so an operator
 * who set a number the relay did not honour can see that from the logs instead
 * of inferring it from connection durations.
 */
function resolvePingTimeoutMs(): number {
  const configuredMs = parsePositiveEnvMs(
    "RELAY_PING_TIMEOUT_MS",
    DEFAULT_PING_TIMEOUT_MS
  );
  if (configuredMs >= MIN_PING_TIMEOUT_MS) {
    return configuredMs;
  }
  log.warn(
    `RELAY_PING_TIMEOUT_MS is below the ${MIN_PING_TIMEOUT_MS}ms floor, raising it`,
    { value: String(configuredMs), floorMs: MIN_PING_TIMEOUT_MS }
  );
  return MIN_PING_TIMEOUT_MS;
}
