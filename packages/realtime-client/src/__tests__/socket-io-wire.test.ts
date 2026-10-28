import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type DrainPayload,
  type JoinAck,
  type JoinPayload,
  PROTOCOL_VERSION,
  REALTIME_SOCKET_PATH,
  RealtimeEvent,
  type SignalPayload,
  type WelcomePayload,
} from "@repo/realtime-contract/protocol";
import { type ExtendedError, Server, type Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSocketIoRealtimeClient,
  type RealtimeClient,
} from "../connection";
import { type RealtimeSignal, RealtimeStatus } from "../port";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CHANNEL = formatChannelAddress(ChannelKind.Comments, ORG, ["artifact-1"]);
const CLIENT_VERSION = "wire/1.0.0";
const WIRE_TIMEOUT_MS = 10_000;

const servers: Server[] = [];
const clients: RealtimeClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((io) => new Promise<void>((resolve) => io.close(() => resolve())))
  );
});

describe("createSocketIoRealtimeClient against a real socket.io server", () => {
  it(
    "handshakes over websocket with token, protocol and version, then joins, resyncs and receives a signal",
    async () => {
      const handshakes: { auth: unknown; transport: string }[] = [];
      const url = await startServer({
        middleware: (socket, next) => {
          handshakes.push({
            auth: socket.handshake.auth,
            transport: socket.conn.transport.name,
          });
          next();
        },
        onConnection: (socket) => {
          welcome(socket);
          acceptJoins(socket, () => {
            // An event this client has no handler for must not disturb it.
            socket.emit("rt:presence", { who: "someone" });
            const signal: SignalPayload = {
              channel: CHANNEL,
              type: "never.seen-before",
              data: { id: "c1", rev: 2 },
            };
            socket.emit(RealtimeEvent.Signal, signal);
          });
        },
      });
      const client = startClient(url);
      const resynced = deferred<void>();
      const signalled = deferred<RealtimeSignal>();

      client.join(CHANNEL, {
        onSignal: signalled.resolve,
        onResync: () => resynced.resolve(),
      });

      await resynced.promise;
      await expect(signalled.promise).resolves.toEqual({
        type: "never.seen-before",
        data: { id: "c1", rev: 2 },
      });
      expect(client.status()).toBe(RealtimeStatus.Open);
      expect(handshakes).toEqual([
        {
          auth: {
            token: "token-1",
            protocol: PROTOCOL_VERSION,
            clientVersion: CLIENT_VERSION,
          },
          transport: "websocket",
        },
      ]);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "connects to the url the token names, with no configured url",
    async () => {
      const url = await startServer({
        onConnection: (socket) => {
          welcome(socket);
          acceptJoins(socket, () => undefined);
        },
      });
      const client = startClient(undefined, url);

      await untilStatus(client, RealtimeStatus.Open);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "reads a middleware refusal's code, and closes after unauthorized twice",
    async () => {
      let refusals = 0;
      const url = await startServer({
        middleware: (_socket, next) => {
          refusals += 1;
          next(
            Object.assign(new Error(RealtimeErrorCode.Unauthorized), {
              data: { code: RealtimeErrorCode.Unauthorized },
            })
          );
        },
        onConnection: welcome,
      });
      const client = startClient(url);

      await untilStatus(client, RealtimeStatus.Closed);

      expect(refusals).toBe(2);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "reconnects and rejoins after the server disconnects it",
    async () => {
      const joins: string[] = [];
      const rejoined = deferred<void>();
      const url = await startServer({
        onConnection: (socket) => {
          welcome(socket);
          acceptJoins(socket, () => {
            joins.push(socket.id);
            if (joins.length === 1) {
              socket.disconnect(true);
            } else {
              rejoined.resolve();
            }
          });
        },
      });
      const client = startClient(url);
      client.join(CHANNEL, {
        onSignal: () => undefined,
        onResync: () => undefined,
      });

      await rejoined.promise;

      expect(joins).toHaveLength(2);
      expect(joins[0]).not.toBe(joins[1]);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "on a drain hint, reconnects, rejoins each held channel once and resyncs it",
    async () => {
      const joinsBySocket = new Map<string, number>();
      const url = await startServer({
        onConnection: (socket) => {
          welcome(socket);
          acceptJoins(socket, () => {
            joinsBySocket.set(
              socket.id,
              (joinsBySocket.get(socket.id) ?? 0) + 1
            );
            if (joinsBySocket.size === 1) {
              const drain: DrainPayload = { afterMs: 20 };
              socket.emit(RealtimeEvent.Drain, drain);
            }
          });
        },
      });
      const client = startClient(url);
      const resynced = deferred<void>();
      let resyncs = 0;
      client.join(CHANNEL, {
        onSignal: () => undefined,
        onResync: () => {
          resyncs += 1;
          if (resyncs === 2) {
            resynced.resolve();
          }
        },
      });

      await resynced.promise;

      expect([...joinsBySocket.values()]).toEqual([1, 1]);
      expect(client.status()).toBe(RealtimeStatus.Open);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "on a drain hint, closes the old connection before opening the new one",
    async () => {
      const sockets: Socket[] = [];
      const reopened = deferred<boolean>();
      const url = await startServer({
        onConnection: (socket) => {
          sockets.push(socket);
          welcome(socket);
          const [first] = sockets;
          if (sockets.length === 1) {
            const drain: DrainPayload = { afterMs: 20 };
            socket.emit(RealtimeEvent.Drain, drain);
          } else {
            reopened.resolve(first?.connected ?? true);
          }
        },
      });
      startClient(url);

      await expect(reopened.promise).resolves.toBe(false);
    },
    WIRE_TIMEOUT_MS
  );
});

type ServerOptions = {
  middleware?: (socket: Socket, next: (error?: ExtendedError) => void) => void;
  onConnection: (socket: Socket) => void;
};

/** Serves socket.io the way apps/realtime does: the contract's path, websocket only. */
async function startServer(options: ServerOptions): Promise<string> {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    path: REALTIME_SOCKET_PATH,
    transports: ["websocket"],
  });
  servers.push(io);
  if (options.middleware) {
    io.use(options.middleware);
  }
  io.on("connection", options.onConnection);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

function startClient(
  url: string | undefined,
  tokenUrl?: string
): RealtimeClient {
  let fetched = 0;
  const client = createSocketIoRealtimeClient({
    url,
    getToken: () => {
      fetched += 1;
      return Promise.resolve({
        token: `token-${fetched}`,
        expiresAt: Date.now() + 600_000,
        ...(tokenUrl === undefined ? {} : { url: tokenUrl }),
      });
    },
    clientVersion: CLIENT_VERSION,
    random: () => 0.5,
  });
  clients.push(client);
  return client;
}

function welcome(socket: Socket): void {
  const payload: WelcomePayload = {
    connectionId: socket.id,
    protocol: PROTOCOL_VERSION,
  };
  socket.emit(RealtimeEvent.Welcome, payload);
}

function acceptJoins(socket: Socket, afterAck: () => void): void {
  socket.on(
    RealtimeEvent.Join,
    (payload: JoinPayload, ack: (response: JoinAck) => void) => {
      socket.join(payload.channel);
      ack({ ok: true, channelId: payload.channel });
      afterAck();
    }
  );
}

function untilStatus(
  client: RealtimeClient,
  status: RealtimeStatus
): Promise<void> {
  return new Promise((resolve) => {
    if (client.status() === status) {
      resolve();
      return;
    }
    const unsubscribe = client.onStatus((next) => {
      if (next === status) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
