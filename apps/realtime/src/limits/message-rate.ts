import { createTokenBucket } from "@repo/http-service/token-bucket";
import { log } from "@repo/observability/log";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type ErrorPayload,
  REALTIME_EVENT_PREFIX,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type { FloodLimit, MessageRateLimit } from "../classes/registry";
import type { RealtimeSocket } from "../edge/socket-server";

/**
 * PLN-2104 step 6, as amended by the operator on 2026-09-30 (PR #8191): one
 * token bucket per socket over every event the client sends, checked before
 * any handler runs. An `rt:*` event over the limit never reaches its handler:
 * it is acked `rate_limited`, or answered with `rt:error { code:
 * "rate_limited" }` when it carried no ack. Any other event over the limit is
 * dropped unanswered. A socket refused `flood.maxRefusals` events within
 * `flood.windowMs` gets `rt:error { code: "rate_limited" }` and is
 * disconnected.
 */
export function attachMessageRateLimit(
  socket: RealtimeSocket,
  limit: MessageRateLimit,
  flood: FloodLimit,
  now: () => number
): void {
  const bucket = createTokenBucket(limit, now);
  const refusals = createRefusalWindow(flood, now);
  socket.use((packet, next) => {
    if (bucket.take()) {
      next();
      return;
    }
    if (refusals.refuse()) {
      disconnectFloodingClient(socket, flood);
      return;
    }
    // socket.io-parser also decodes a numeric event name, which the `Event`
    // type hides; a throw here would be uncaught and end the process.
    const event: unknown = packet[0];
    if (typeof event === "string" && event.startsWith(REALTIME_EVENT_PREFIX)) {
      answerRateLimited(socket, packet);
    }
  });
}

/** Counts refusals in a fixed window opened by the first refusal after the last one closed. */
function createRefusalWindow(flood: FloodLimit, now: () => number) {
  let windowStartedAt = Number.NEGATIVE_INFINITY;
  let refused = 0;
  return {
    /** Records one refusal; true once the window holds `maxRefusals`. */
    refuse(): boolean {
      const at = now();
      if (at - windowStartedAt >= flood.windowMs) {
        windowStartedAt = at;
        refused = 0;
      }
      refused += 1;
      return refused >= flood.maxRefusals;
    },
  };
}

function answerRateLimited(
  socket: RealtimeSocket,
  packet: readonly unknown[]
): void {
  const ack: unknown = packet.at(-1);
  if (typeof ack === "function") {
    ack(RATE_LIMITED_ACK);
    return;
  }
  socket.emit(RealtimeEvent.Error, RATE_LIMITED_ERROR);
}

function disconnectFloodingClient(
  socket: RealtimeSocket,
  flood: FloodLimit
): void {
  log.warn("Realtime disconnected a flooding client", {
    event: FLOODING_CLIENT_DISCONNECTED_EVENT,
    socketId: socket.id,
    refusals: flood.maxRefusals,
    windowMs: flood.windowMs,
  });
  socket.emit(RealtimeEvent.Error, RATE_LIMITED_ERROR);
  socket.disconnect(true);
}

const RATE_LIMITED_ACK = {
  ok: false,
  code: RealtimeErrorCode.RateLimited,
} as const;

const RATE_LIMITED_ERROR: ErrorPayload = {
  code: RealtimeErrorCode.RateLimited,
};

export const FLOODING_CLIENT_DISCONNECTED_EVENT =
  "realtime.flooding_client_disconnected";
