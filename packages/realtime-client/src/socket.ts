import {
  type HandshakeAuth,
  REALTIME_SOCKET_PATH,
} from "@repo/realtime-contract/protocol";
import type { ManagerOptions, SocketOptions } from "socket.io-client";
import type { Backoff } from "./backoff";

/**
 * The part of a socket.io-client `Socket` the client uses, so tests can supply
 * a fake. `on` is a method so socket.io's typed overloads stay assignable;
 * listeners take `unknown` because every payload crosses a wire.
 */
export type RealtimeSocket = {
  readonly connected: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  readonly io: {
    on(event: "reconnect_attempt", listener: () => void): unknown;
  };
};

export type RealtimeSocketOptions = Partial<ManagerOptions & SocketOptions>;

export type CreateRealtimeSocket = (
  url: string,
  options: RealtimeSocketOptions
) => RealtimeSocket;

export type SocketAuth = (callback: (auth: HandshakeAuth) => void) => void;

/**
 * socket.io's reconnect backoff (PLN-2106 decision 2). The client reuses it for
 * the reconnects socket.io leaves to the caller: a handshake the server
 * refused, and a disconnect the server initiated.
 */
export const RECONNECT_BACKOFF: Backoff = {
  minMs: 500,
  maxMs: 30_000,
  randomizationFactor: 0.5,
};

/**
 * Every socket.io option the client sets, in one place (PLN-2106 decision 2).
 * `auth` is a function, so every reconnect presents a fresh token.
 * `autoConnect: false` lets the handlers attach first, and `forceNew` keeps two
 * clients on one URL from sharing a connection.
 */
export function realtimeSocketOptions(auth: SocketAuth): RealtimeSocketOptions {
  return {
    transports: ["websocket"],
    path: REALTIME_SOCKET_PATH,
    reconnectionDelay: RECONNECT_BACKOFF.minMs,
    reconnectionDelayMax: RECONNECT_BACKOFF.maxMs,
    randomizationFactor: RECONNECT_BACKOFF.randomizationFactor,
    autoConnect: false,
    forceNew: true,
    auth,
  };
}
