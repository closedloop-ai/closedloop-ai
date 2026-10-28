import type { ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { VerifiedApiKeyContext } from "./api-key-contract.js";
import { parsePositiveIntegerEnv } from "./env-parse.js";
import { logMcpEvent } from "./log-event.js";
import { sendTemporarilyUnavailable } from "./oauth-http.js";

/**
 * The live MCP session table: what a session retains, the two bounds that keep
 * that retention finite, and what a client is told when a bound refuses it.
 *
 * Split out of `index.ts` (ISS-8264) because session retention is a distinct
 * responsibility from HTTP routing, and because the bug this module exists to
 * prevent was invisible while the map, its TTL, and its only sweep call site
 * were scattered through a 3,700-line entrypoint.
 *
 * Each session holds a complete `McpServer` — all 49 tools with their Zod
 * schemas and closures — so the map is bounded on BOTH axes:
 *
 *   - time  (`MCP_SERVER_CACHE_TTL_MS`) — idle sessions expire, and
 *   - count (`MCP_MAX_SESSIONS`)        — a burst evicts least-recently-used,
 *     and is refused once there is nothing left to evict.
 *
 * The count bound is the load-bearing one. Arrival rate, not idle time, is what
 * fills the heap: prod retained servers without limit under a reconnect storm
 * and the process aborted on V8 heap exhaustion.
 */

export type ResolvedMcpAuth = {
  plaintextKey: string;
  context: VerifiedApiKeyContext;
  grantedScopes: string[];
};

export type McpSession = {
  auth: ResolvedMcpAuth;
  lastActivityMs: number;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

export const MCP_SERVER_CACHE_TTL_MS = parsePositiveIntegerEnv(
  "MCP_SERVER_CACHE_TTL_MS",
  60_000
);
export const MCP_MAX_SESSIONS = parsePositiveIntegerEnv(
  "MCP_MAX_SESSIONS",
  200
);
// The per-request sweep only runs when a request arrives, so a burst that then
// goes quiet would leave every one of its sessions resident until the next one
// lands.
//
// Capped at Node's maximum timer delay: a larger value overflows the 32-bit
// delay and `setInterval` fires every 1ms instead, turning a setting meant to
// sweep rarely into the hottest loop in the process.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MCP_SESSION_SWEEP_INTERVAL_MS = parsePositiveIntegerEnv(
  "MCP_SESSION_SWEEP_INTERVAL_MS",
  30_000,
  1,
  MAX_TIMER_DELAY_MS
);

// A shed client should come back promptly: slots turn over as fast as the burst
// that took them drains.
export const MCP_CAPACITY_RETRY_AFTER_SECONDS = 1;

/**
 * Which POST the capacity bound turned away. Both refusals are a POST, so
 * `method` cannot tell them apart, and they are not the same operational event:
 * `Initialize` sheds a client that has no session yet, `StatelessRebuild` sheds
 * an in-flight call from a client that believes it has one. Carried as its own
 * facet so a monitor can group on it rather than on the line before it.
 */
export const McpCapacityRefusalReason = {
  Initialize: "initialize",
  StatelessRebuild: "stateless-rebuild",
} as const;
export type McpCapacityRefusalReason =
  (typeof McpCapacityRefusalReason)[keyof typeof McpCapacityRefusalReason];

export const mcpSessions = new Map<string, McpSession>();

let mcpSessionSweepTimer: ReturnType<typeof setInterval> | undefined;

export function closeMcpSession(sessionId: string, session: McpSession): void {
  mcpSessions.delete(sessionId);
  session.server.close().catch(() => {});
}

export function cleanupExpiredMcpSessions(nowMs: number): void {
  for (const [sessionId, session] of mcpSessions.entries()) {
    if (nowMs - session.lastActivityMs > MCP_SERVER_CACHE_TTL_MS) {
      closeMcpSession(sessionId, session);
    }
  }
}

function findLeastRecentlyUsedMcpSession(): [string, McpSession] | undefined {
  let lruEntry: [string, McpSession] | undefined;
  for (const entry of mcpSessions.entries()) {
    if (!lruEntry || entry[1].lastActivityMs < lruEntry[1].lastActivityMs) {
      lruEntry = entry;
    }
  }
  return lruEntry;
}

// Servers that have been built but not yet admitted. They hold exactly as much
// heap as an admitted one, and the map cannot see them, so the bound has to
// count them.
let pendingMcpSessions = 0;

function evictWhileOverCapacity(occupiedLimit: number): void {
  while (mcpSessions.size + pendingMcpSessions > occupiedLimit) {
    const lruEntry = findLeastRecentlyUsedMcpSession();
    if (!lruEntry) {
      return;
    }
    closeMcpSession(lruEntry[0], lruEntry[1]);
    logMcpEvent("session-evicted", {
      sessionId: lruEntry[0],
      reason: "capacity",
      retained: mcpSessions.size,
    });
  }
}

/**
 * A claim on one session slot, held from before `createMcpServer` until the
 * session is admitted or abandoned. Carrying the released flag on the token
 * rather than in module state makes a double release a no-op instead of a
 * silent steal of some other in-flight request's slot.
 */
export type McpSessionReservation = { released: boolean };

/**
 * Claim one session slot before the `McpServer` is built, or refuse.
 *
 * Claiming up front is necessary but not sufficient. Each server carries all 49
 * tools with their Zod schemas, and a concurrent reconnect burst can have every
 * handler finish `createMcpServer` while the map is still under the cap — so a
 * check that only runs at admission never sees the servers that already exist.
 *
 * Refusing is the half that actually bounds the peak. Eviction can only reclaim
 * a slot while some session still holds one: a burst larger than the cap drains
 * the whole table and then has nothing left to evict, so granting the surplus
 * anyway puts one server per in-flight request on the heap — the exact spike
 * this bound exists to prevent — and destroys every established session on the
 * way there. `undefined` means the caller must not build a server.
 */
export function reserveMcpSessionCapacity(): McpSessionReservation | undefined {
  pendingMcpSessions += 1;
  evictWhileOverCapacity(MCP_MAX_SESSIONS);
  if (mcpSessions.size + pendingMcpSessions > MCP_MAX_SESSIONS) {
    pendingMcpSessions -= 1;
    return undefined;
  }
  return { released: false };
}

/**
 * Shed one POST for capacity — an `initialize` that would open a session, or a
 * stateless rebuild carrying any JSON-RPC method (`tools/call`, `tools/list`)
 * for a session this task does not hold (ISS-8394). `reason` is what separates
 * the two; `method` is `POST` for both.
 *
 * Its own event and its own status, never `session-evicted` and never a generic
 * error: no session of this client's is being destroyed here, and the retry it
 * is being told to make will work — so it must not be told its session is gone
 * or its request was bad. A rebuild is refused after the client's session may
 * already have been evicted by this module, so the shed request can be the
 * second thing that happened to it, not the first.
 */
export function refuseMcpSessionForCapacity(
  res: ServerResponse,
  method: string | undefined,
  reason: McpCapacityRefusalReason
): void {
  logMcpEvent("session-capacity-refused", {
    method,
    reason,
    retained: mcpSessions.size,
  });
  sendTemporarilyUnavailable(
    res,
    `MCP session capacity (${MCP_MAX_SESSIONS}) is fully committed. Retry shortly.`,
    MCP_CAPACITY_RETRY_AFTER_SECONDS
  );
}

export function releaseMcpSessionCapacity(
  reservation: McpSessionReservation
): void {
  if (reservation.released) {
    return;
  }
  reservation.released = true;
  pendingMcpSessions -= 1;
}

// Admission consumes the claim `reserveMcpSessionCapacity` already granted, so
// the count bound is enforced there rather than here; this eviction only makes
// room for the session being admitted. An evicted client's next POST carries an
// unknown session id and takes the stateless path, the same route it already
// takes after a task restart — but since ISS-8394 that rebuild claims a slot
// too, so it is served only if one can be found, and shed 503 if not.
export function admitMcpSession(
  sessionId: string,
  session: McpSession,
  reservation?: McpSessionReservation
): void {
  if (reservation) {
    releaseMcpSessionCapacity(reservation);
  }
  evictWhileOverCapacity(MCP_MAX_SESSIONS - 1);
  mcpSessions.set(sessionId, session);
}

export function startMcpSessionSweep(): void {
  if (mcpSessionSweepTimer) {
    return;
  }
  mcpSessionSweepTimer = setInterval(() => {
    cleanupExpiredMcpSessions(Date.now());
  }, MCP_SESSION_SWEEP_INTERVAL_MS);
  // The sweep must never be the reason the process stays alive at shutdown.
  mcpSessionSweepTimer.unref();
}

// Reservations are module state and outlive a single test, so a case that
// abandons one would silently shrink every later case's effective capacity.
export function resetMcpSessionCapacity(): void {
  pendingMcpSessions = 0;
}

export function stopMcpSessionSweep(): void {
  if (!mcpSessionSweepTimer) {
    return;
  }
  clearInterval(mcpSessionSweepTimer);
  mcpSessionSweepTimer = undefined;
}
