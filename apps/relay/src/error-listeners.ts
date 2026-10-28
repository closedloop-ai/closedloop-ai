/**
 * Error-channel observability for the relay's transport surfaces.
 *
 * Each surface below emits an `error` event that had no listener. On an
 * EventEmitter an unhandled `error` is not merely unlogged — Node re-throws it
 * as an uncaught exception, so a single client-side transport fault could take
 * the whole relay process down. Every handler here logs and returns; none of
 * them exit.
 */

import type { Server as HttpServer } from "node:http";
import { log } from "@repo/observability/log";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import type { Server, Socket } from "socket.io";

type SocketErrorContext = {
  organizationId?: string;
  userId?: string;
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "unknown";
}

/**
 * Lifetime `error` listener for the HTTP server.
 *
 * `startRelayServer` registers a one-shot `error` listener only to reject the
 * bind promise, and drops it once `listening` fires. Without this the server
 * runs its entire post-bind life with zero `error` listeners.
 */
export function attachHttpServerErrorLogging(server: HttpServer): void {
  server.on("error", (error: Error) => {
    log.error("Relay HTTP server error", {
      errorClass: ErrorClass.Connection,
      code: (error as NodeJS.ErrnoException).code,
      error: describeError(error),
    });
  });
}

/**
 * Per-socket `error` listener. Socket.IO's `Socket._onerror` emits a reserved
 * `error` for a malformed inbound packet or a middleware rejection, so this is
 * a protocol-class fault rather than a transport one.
 */
export function attachSocketErrorLogging(
  socket: Pick<Socket, "id" | "on">,
  context: SocketErrorContext = {}
): void {
  socket.on("error", (error: unknown) => {
    log.error("Relay socket error", {
      socketId: socket.id,
      errorClass: ErrorClass.Protocol,
      organizationId: context.organizationId,
      userId: context.userId,
      error: describeError(error),
    });
  });
}

type EngineConnectionError = {
  code?: number;
  message?: string;
};

/**
 * Engine.IO `connection_error` listener. These are handshake failures — an
 * unsupported protocol version, a rejected origin, a bad request — that occur
 * before any Socket exists, so no per-socket handler can observe them.
 *
 * Deliberately logs only `code` and `message`: the event also carries the raw
 * `req` (headers, and a `sid` in the query string), which must not reach a log
 * sink.
 */
export function attachEngineConnectionErrorLogging(io: Server): void {
  io.engine.on("connection_error", (error: EngineConnectionError) => {
    log.warn("Relay engine connection error", {
      errorClass: ErrorClass.Connection,
      code: error?.code,
      error: error?.message ?? "unknown",
    });
  });
}
