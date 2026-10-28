import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";
import { vi } from "vitest";
import {
  createSocketIoRealtimeClient,
  type SocketIoRealtimeClientOptions,
} from "../connection";
import { type FakeSocket, FakeSockets } from "./fake-socket";

export const SERVICE_URL = "wss://realtime.example.test";
export const CLIENT_VERSION = "test/1.0.0";
export const TOKEN_TTL_MS = 600_000;

/**
 * A client on fake sockets, before its first token fetch settles. Tokens are
 * numbered `token-1`, `token-2`, ... in fetch order and expire
 * `TOKEN_TTL_MS` after the fetch. `random` is 0.5, so every backoff delay is
 * its unjittered base. Needs fake timers.
 */
export function createClient(
  overrides: Partial<SocketIoRealtimeClientOptions> = {}
) {
  const sockets = new FakeSockets();
  let fetched = 0;
  const getToken = vi.fn((): Promise<IssuedRealtimeToken> => {
    fetched += 1;
    return Promise.resolve({
      token: `token-${fetched}`,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
  });
  const client = createSocketIoRealtimeClient({
    url: SERVICE_URL,
    getToken,
    clientVersion: CLIENT_VERSION,
    createSocket: sockets.create,
    random: () => 0.5,
    ...overrides,
  });
  return { sockets, getToken, client };
}

/** `createClient`, once its first token fetch has created the socket. */
export async function startClient(
  overrides: Partial<SocketIoRealtimeClientOptions> = {}
) {
  const started = createClient(overrides);
  await settle();
  const [socket] = started.sockets.created;
  if (socket === undefined) {
    throw new Error("the client created no socket");
  }
  return { ...started, socket };
}

/** Lets pending token fetches settle. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Completes a handshake and welcome; resolves with the auth presented. */
export async function openConnection(socket: FakeSocket) {
  const auth = await socket.handshake();
  socket.accept();
  return auth;
}
