import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type IssuedRealtimeToken,
  PROTOCOL_VERSION,
  REALTIME_SOCKET_PATH,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeStatus } from "../port";
import { REFRESH_AT_FRACTION } from "../token-refresh";
import {
  CLIENT_VERSION,
  createClient,
  openConnection,
  SERVICE_URL,
  settle,
  startClient,
  TOKEN_TTL_MS,
} from "./client-harness";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSocketIoRealtimeClient: connection", () => {
  it("opens one websocket-only socket on the contract's path", async () => {
    const { socket } = await startClient();

    expect(socket.url).toBe(SERVICE_URL);
    expect(socket.options).toMatchObject({
      transports: ["websocket"],
      path: REALTIME_SOCKET_PATH,
      reconnectionDelay: 500,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    expect(socket.calls).toEqual(["connect"]);
  });

  it("presents a freshly fetched token on every handshake", async () => {
    const { socket, getToken } = await startClient();

    await expect(socket.handshake()).resolves.toEqual({
      token: "token-1",
      protocol: PROTOCOL_VERSION,
      clientVersion: CLIENT_VERSION,
    });
    await expect(socket.handshake()).resolves.toMatchObject({
      token: "token-2",
    });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("maps socket events to status", async () => {
    const { socket, client } = await startClient();
    const seen: string[] = [];
    client.onStatus((status) => seen.push(status));
    expect(client.status()).toBe(RealtimeStatus.Connecting);

    socket.fire("connect_error", new Error("websocket error"));
    expect(client.status()).toBe(RealtimeStatus.Connecting);

    await socket.handshake();
    socket.connected = true;
    socket.fire("connect");
    expect(client.status()).toBe(RealtimeStatus.Connecting);
    socket.fire(RealtimeEvent.Welcome, {
      connectionId: "c",
      protocol: PROTOCOL_VERSION,
    });
    expect(client.status()).toBe(RealtimeStatus.Open);

    socket.drop("transport close");
    expect(client.status()).toBe(RealtimeStatus.Degraded);
    await openConnection(socket);
    socket.fireManager("reconnect_attempt");
    expect(client.status()).toBe(RealtimeStatus.Degraded);

    client.close();
    expect(client.status()).toBe(RealtimeStatus.Closed);
    expect(seen).toEqual([
      RealtimeStatus.Open,
      RealtimeStatus.Degraded,
      RealtimeStatus.Open,
      RealtimeStatus.Degraded,
      RealtimeStatus.Closed,
    ]);
  });

  it("leaves a dropped transport to socket.io's own reconnect", async () => {
    const { socket } = await startClient();
    await openConnection(socket);

    socket.drop("transport close");
    socket.fire("connect_error", new Error("websocket error"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect"]);
  });

  it("on a drain hint, closes, then reconnects after afterMs", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);

    socket.fire(RealtimeEvent.Drain, { afterMs: 5000 });
    expect(socket.calls).toEqual(["connect", "disconnect"]);
    expect(client.status()).toBe(RealtimeStatus.Degraded);

    await vi.advanceTimersByTimeAsync(4999);
    expect(socket.calls).toEqual(["connect", "disconnect"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.calls).toEqual(["connect", "disconnect", "connect"]);
  });

  it("on a mid-connection token_expired, reconnects at once with a fresh token", async () => {
    const { socket, getToken } = await startClient();
    await openConnection(socket);

    socket.fire(RealtimeEvent.Error, { code: RealtimeErrorCode.TokenExpired });
    expect(socket.calls).toEqual(["connect", "disconnect"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.calls).toEqual(["connect", "disconnect", "connect"]);

    await expect(socket.handshake()).resolves.toMatchObject({
      token: "token-2",
    });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("closes for good after unauthorized twice in a row, reporting it to its channels", async () => {
    const { socket, client } = await startClient();
    const onError = vi.fn();
    client.join(CHANNEL, listenerWith(onError));

    await socket.handshake();
    socket.refuse(RealtimeErrorCode.Unauthorized);
    expect(client.status()).toBe(RealtimeStatus.Connecting);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.calls).toEqual(["connect", "connect"]);

    await socket.handshake();
    socket.refuse(RealtimeErrorCode.Unauthorized);
    expect(client.status()).toBe(RealtimeStatus.Closed);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      RealtimeErrorCode.Unauthorized
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.calls).toEqual(["connect", "connect", "disconnect"]);
  });

  it("closes for good at once when the service refuses this build's protocol", async () => {
    const { socket, client } = await startClient();
    const onError = vi.fn();
    client.join(CHANNEL, listenerWith(onError));

    socket.refuse(RealtimeErrorCode.UnknownKind);
    expect(client.status()).toBe(RealtimeStatus.Closed);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      RealtimeErrorCode.UnknownKind
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.calls).toEqual(["connect", "disconnect"]);
  });

  it("reports a join after close to its listener and holds nothing", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    client.close();
    const onError = vi.fn();

    const leave = client.join(CHANNEL, listenerWith(onError));
    socket.connected = true;
    socket.fire("connect");

    expect(onError).toHaveBeenCalledExactlyOnceWith(RealtimeErrorCode.Internal);
    expect(socket.sent(RealtimeEvent.Join)).toHaveLength(0);
    leave();
  });

  it("resets the unauthorized count on any other code or a successful connect", async () => {
    const { socket, client } = await startClient();

    socket.refuse(RealtimeErrorCode.Unauthorized);
    socket.refuse(RealtimeErrorCode.RateLimited);
    socket.refuse(RealtimeErrorCode.Unauthorized);
    expect(client.status()).toBe(RealtimeStatus.Connecting);

    await openConnection(socket);
    socket.drop("transport close");
    socket.refuse(RealtimeErrorCode.Unauthorized);
    expect(client.status()).toBe(RealtimeStatus.Degraded);
  });

  it("retries a refused handshake with backoff, since socket.io will not", async () => {
    const { socket } = await startClient();

    socket.refuse(RealtimeErrorCode.RateLimited);
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.calls).toEqual(["connect"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.calls).toEqual(["connect", "connect"]);

    socket.refuse("a_code_from_a_newer_service");
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.calls).toEqual(["connect", "connect"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.calls).toEqual(["connect", "connect", "connect"]);
  });

  it("reconnects with backoff after the server disconnects it", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);

    socket.drop("io server disconnect");
    expect(client.status()).toBe(RealtimeStatus.Degraded);
    await vi.advanceTimersByTimeAsync(500);

    expect(socket.calls).toEqual(["connect", "connect"]);
  });

  it("abandons a handshake whose token fetch failed and retries with backoff", async () => {
    const getToken = vi
      .fn<() => Promise<IssuedRealtimeToken>>()
      .mockResolvedValueOnce({ token: "token-1", expiresAt: Date.now() + 1 })
      .mockRejectedValue(new Error("offline"));
    const { socket } = await startClient({ getToken });
    await socket.handshake();
    const presented = vi.fn();

    socket.runAuth(presented);
    await vi.advanceTimersByTimeAsync(0);
    expect(presented).not.toHaveBeenCalled();
    expect(socket.calls).toEqual(["connect", "disconnect"]);

    await vi.advanceTimersByTimeAsync(500);
    expect(socket.calls).toEqual(["connect", "disconnect", "connect"]);
  });

  it("stops reconnecting once closed", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    socket.fire(RealtimeEvent.Drain, { afterMs: 1000 });

    client.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect", "disconnect", "disconnect"]);
    expect(client.status()).toBe(RealtimeStatus.Closed);
  });
});

describe("createSocketIoRealtimeClient: service url", () => {
  it("connects to the url the token names ahead of the configured one", async () => {
    const { socket } = await startClient({
      getToken: () => Promise.resolve(tokenWithUrl("token-1", TOKEN_URL)),
    });

    expect(socket.url).toBe(TOKEN_URL);
  });

  it.each([
    ["no url", undefined],
    ["an http url", "https://realtime.example.test"],
    ["a malformed url", "not a url"],
  ])("falls back to the configured url for a token with %s", async (_, url) => {
    const { socket } = await startClient({
      getToken: () => Promise.resolve(tokenWithUrl("token-1", url)),
    });

    expect(socket.url).toBe(SERVICE_URL);
  });

  it("moves to the url a later token names on the next reconnect", async () => {
    const getToken = vi
      .fn<() => Promise<IssuedRealtimeToken>>()
      .mockResolvedValueOnce(tokenWithUrl("token-1", TOKEN_URL))
      .mockResolvedValueOnce(tokenWithUrl("token-2", OTHER_TOKEN_URL));
    const { sockets, socket, client } = await startClient({ getToken });
    await openConnection(socket);
    socket.drop("transport close");
    const presented = vi.fn();

    socket.runAuth(presented);
    await settle();

    expect(presented).not.toHaveBeenCalled();
    expect(socket.calls).toEqual(["connect", "disconnect"]);
    const [, moved] = sockets.created;
    expect(moved?.url).toBe(OTHER_TOKEN_URL);
    expect(moved?.calls).toEqual(["connect"]);
    await expect(moved?.handshake()).resolves.toMatchObject({
      token: "token-2",
    });
    expect(getToken).toHaveBeenCalledTimes(2);
    moved?.accept();
    expect(client.status()).toBe(RealtimeStatus.Open);
  });

  it.each([
    ["the options name none", undefined],
    ["the options name another", SERVICE_URL],
  ])(
    "stays on the url it is on when a later token names none and %s",
    async (_, url) => {
      const getToken = vi
        .fn<() => Promise<IssuedRealtimeToken>>()
        .mockResolvedValueOnce(tokenWithUrl("token-1", TOKEN_URL))
        .mockResolvedValueOnce(tokenWithUrl("token-2", undefined));
      const { sockets, socket, client } = await startClient({ url, getToken });
      await openConnection(socket);
      socket.drop("transport close");
      const presented = vi.fn();

      socket.runAuth(presented);
      await settle();

      expect(presented).toHaveBeenCalledWith(
        expect.objectContaining({ token: "token-2" })
      );
      expect(sockets.created).toHaveLength(1);
      expect(client.status()).toBe(RealtimeStatus.Degraded);
    }
  );

  it("connects to the origin of a token url that carries a path", async () => {
    const { socket } = await startClient({
      getToken: () =>
        Promise.resolve(tokenWithUrl("token-1", `${TOKEN_URL}/realtime`)),
    });

    expect(socket.url).toBe(TOKEN_URL);
  });

  it("connects to the origin of a configured url that carries a path", async () => {
    const { socket } = await startClient({ url: `${SERVICE_URL}/realtime` });

    expect(socket.url).toBe(SERVICE_URL);
  });

  it("closes and reports internal to its channels when neither the token nor the options name a url", async () => {
    const { sockets, client } = createClient({ url: undefined });
    const onError = vi.fn();
    client.join(CHANNEL, {
      onSignal: () => undefined,
      onResync: () => undefined,
      onError,
    });

    await settle();

    expect(sockets.created).toHaveLength(0);
    expect(client.status()).toBe(RealtimeStatus.Closed);
    expect(onError).toHaveBeenCalledWith(RealtimeErrorCode.Internal);
  });

  it("retries the first token fetch with backoff before any socket exists", async () => {
    const getToken = vi
      .fn<() => Promise<IssuedRealtimeToken>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(tokenWithUrl("token-2", undefined));
    const { sockets } = createClient({ getToken });

    await settle();
    expect(sockets.created).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);

    expect(sockets.created.map((socket) => socket.url)).toEqual([SERVICE_URL]);
  });
});

describe("createSocketIoRealtimeClient: token refresh", () => {
  it("refreshes in place at 80% of the token's lifetime, then from the ack's expiry", async () => {
    const { socket } = await startClient();
    await openConnection(socket);

    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS * REFRESH_AT_FRACTION - 1);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(1);
    expect(socket.sent(RealtimeEvent.Refresh)[0]?.args[0]).toEqual({
      token: "token-2",
    });
    expect(socket.calls).toEqual(["connect"]);

    // The ack's expiry, not the token's nominal TTL, sets the next refresh.
    socket.ack(RealtimeEvent.Refresh, {
      ok: true,
      expiresAt: Date.now() + ACK_TTL_MS,
    });
    await vi.advanceTimersByTimeAsync(ACK_TTL_MS * REFRESH_AT_FRACTION - 1);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent(RealtimeEvent.Refresh)[1]?.args[0]).toEqual({
      token: "token-3",
    });
    expect(socket.calls).toEqual(["connect"]);
  });

  it("keeps the connection when a refresh is refused, and expiry then reconnects with a fresh token", async () => {
    const { socket } = await startClient();
    await openConnection(socket);
    await vi.advanceTimersByTimeAsync(480_000);

    socket.ack(RealtimeEvent.Refresh, {
      ok: false,
      code: RealtimeErrorCode.Internal,
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(1);
    expect(socket.calls).toEqual(["connect"]);

    socket.fire(RealtimeEvent.Error, { code: RealtimeErrorCode.TokenExpired });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.calls).toEqual(["connect", "disconnect", "connect"]);
    await expect(socket.handshake()).resolves.toMatchObject({
      token: "token-3",
    });
  });

  it("keeps the connection when the refresh token fetch fails", async () => {
    let fetched = 0;
    const getToken = vi.fn(() => {
      fetched += 1;
      return fetched === 1
        ? Promise.resolve({ token: "token-1", expiresAt: Date.now() + 600_000 })
        : Promise.reject(new Error("offline"));
    });
    const { socket } = await startClient({ getToken });
    await openConnection(socket);

    await vi.advanceTimersByTimeAsync(600_000);

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(0);
    expect(socket.calls).toEqual(["connect"]);
  });

  it("does not refresh a connection that has dropped", async () => {
    const { socket, getToken } = await startClient();
    await openConnection(socket);

    socket.drop("transport close");
    await vi.advanceTimersByTimeAsync(600_000);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(0);
  });
});

const ACK_TTL_MS = 100_000;
const TOKEN_URL = "wss://token-named.example.test";
const OTHER_TOKEN_URL = "wss://moved.example.test";
const CHANNEL = formatChannelAddress(
  ChannelKind.Comments,
  "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  ["artifact-1"]
);

function listenerWith(onError: (code: RealtimeErrorCode) => void) {
  return { onSignal: () => undefined, onResync: () => undefined, onError };
}

function tokenWithUrl(
  token: string,
  url: string | undefined
): IssuedRealtimeToken {
  return {
    token,
    expiresAt: Date.now() + 600_000,
    ...(url === undefined ? {} : { url }),
  };
}
