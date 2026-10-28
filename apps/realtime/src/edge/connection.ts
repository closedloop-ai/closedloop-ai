import { log } from "@repo/observability/log";
import {
  PROTOCOL_VERSION,
  RealtimeEvent,
  type WelcomePayload,
} from "@repo/realtime-contract/protocol";
import type { Revocations } from "@repo/realtime-contract/revocations";
import type { RealtimeTokenVerifyOptions } from "@repo/realtime-contract/token";
import {
  type ConnectionLimits,
  connectionLimitsAcrossClasses,
  deliveryClassRuntimes,
} from "../classes/registry";
import { attachMessageRateLimit } from "../limits/message-rate";
import { dropSlowClient } from "../limits/slow-client";
import { startConnectionSpan } from "../telemetry/spans";
import {
  type ConnectionAdmitter,
  createAdmissionMiddleware,
} from "./admission";
import { createAuthMiddleware } from "./auth-middleware";
import { describeFault } from "./fault";
import { registerHandlers } from "./handlers";
import type { RealtimeServer, RealtimeSocket } from "./socket-server";
import {
  armTokenExpiry,
  type Clock,
  type ConnectionState,
  clearTokenExpiry,
} from "./token-expiry";

export type EdgeOptions = {
  tokenKeys: RealtimeTokenVerifyOptions;
  now?: Clock;
  /** Unset never drains. */
  isDraining?: () => boolean;
  /** Unset admits every authenticated connection uncounted. */
  admitter?: ConnectionAdmitter;
  /** The revokes a join and a refresh are checked against. */
  revocations: Revocations;
};

export function attachEdge(io: RealtimeServer, options: EdgeOptions): void {
  const now = options.now ?? Date.now;
  const limits = connectionLimitsAcrossClasses();
  io.use(
    createAuthMiddleware({
      tokenKeys: options.tokenKeys,
      isDraining: options.isDraining ?? (() => false),
    })
  );
  if (options.admitter) {
    io.use(createAdmissionMiddleware(options.admitter));
  }
  io.on("connection", (socket) =>
    onConnection(socket, {
      tokenKeys: options.tokenKeys,
      now,
      limits,
      revocations: options.revocations,
    })
  );
}

function onConnection(
  socket: RealtimeSocket,
  options: {
    tokenKeys: RealtimeTokenVerifyOptions;
    now: Clock;
    limits: ConnectionLimits;
    revocations: Revocations;
  }
): void {
  const state: ConnectionState = { expiryTimer: undefined };
  const endConnectionSpan = startConnectionSpan(socket);
  // socket.io emits `error` for a malformed inbound packet (and a client may
  // emit one itself); with no listener the EventEmitter throws and the
  // process dies.
  socket.on("error", (error: unknown) => {
    log.error("Realtime socket error", {
      event: SOCKET_ERROR_EVENT,
      socketId: socket.id,
      error: describeFault(error),
    });
  });
  socket.on("disconnect", (reason) => {
    clearTokenExpiry(state);
    endConnectionSpan(reason);
  });
  attachMessageRateLimit(
    socket,
    options.limits.messageRate,
    options.limits.flood,
    options.now
  );
  dropSlowClient(socket, options.limits.maxBufferedPackets);
  registerHandlers(socket, state, options);
  const welcome: WelcomePayload = {
    connectionId: socket.id,
    protocol: PROTOCOL_VERSION,
  };
  socket.emit(RealtimeEvent.Welcome, welcome);
  armTokenExpiry(state, socket, options.now);
  for (const runtime of deliveryClassRuntimes()) {
    runtime.onConnection(socket);
  }
}

export const SOCKET_ERROR_EVENT = "realtime.socket_error";
