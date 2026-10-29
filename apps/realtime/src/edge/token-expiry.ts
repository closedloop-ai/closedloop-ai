import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type ErrorPayload,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import type { RealtimeTokenClaims } from "@repo/realtime-contract/token";
import type { RealtimeSocket } from "./socket-server";

/** Per-socket edge state that outlives a single event. */
export type ConnectionState = {
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
};

export type Clock = () => number;

/** JWT `exp` is epoch seconds; everything this service emits is epoch milliseconds. */
export function tokenExpiresAtMs(claims: RealtimeTokenClaims): number {
  return claims.exp * 1000;
}

/**
 * (Re)arms the expiry for the socket's current claims. When it fires with no
 * refresh having arrived, the socket gets `rt:error { code: "token_expired" }`
 * and is disconnected; the client's auth callback presents a fresh token on
 * reconnect.
 */
export function armTokenExpiry(
  state: ConnectionState,
  socket: RealtimeSocket,
  now: Clock
): void {
  clearTokenExpiry(state);
  if (!socket.connected) {
    return;
  }
  const expiresAtMs = tokenExpiresAtMs(socket.data.claims);
  const delayMs = Math.min(
    Math.max(0, expiresAtMs - now()),
    MAX_TIMER_DELAY_MS
  );
  state.expiryTimer = setTimeout(() => {
    state.expiryTimer = undefined;
    if (now() < expiresAtMs) {
      armTokenExpiry(state, socket, now);
      return;
    }
    const payload: ErrorPayload = { code: RealtimeErrorCode.TokenExpired };
    socket.emit(RealtimeEvent.Error, payload);
    socket.disconnect(true);
  }, delayMs);
}

export function clearTokenExpiry(state: ConnectionState): void {
  if (state.expiryTimer !== undefined) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = undefined;
  }
}

/** Node's timer ceiling; a longer delay would fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
