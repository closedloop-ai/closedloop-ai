import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  type IssuedRealtimeToken,
  PROTOCOL_VERSION,
  RealtimeEvent,
} from "@repo/realtime-contract/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeStatus } from "../port";
import {
  createClient,
  openConnection,
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

describe("createSocketIoRealtimeClient: stale and ignored events", () => {
  it("opens no socket when closed before the first token arrives", async () => {
    let resolve: (token: IssuedRealtimeToken) => void = () => undefined;
    const getToken = vi.fn(
      () =>
        new Promise<IssuedRealtimeToken>((r) => {
          resolve = r;
        })
    );
    const { sockets, client } = createClient({ getToken });

    client.close();
    resolve({ token: "late", expiresAt: Date.now() + TOKEN_TTL_MS });
    await settle();

    expect(sockets.created).toEqual([]);
    expect(client.status()).toBe(RealtimeStatus.Closed);
  });

  it("schedules no retry when closed before the first token fetch fails", async () => {
    let reject: (error: Error) => void = () => undefined;
    const getToken = vi.fn(
      () =>
        new Promise<IssuedRealtimeToken>((_resolve, r) => {
          reject = r;
        })
    );
    const { sockets, client } = createClient({ getToken });

    client.close();
    reject(new Error("offline"));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(sockets.created).toEqual([]);
  });

  it("ignores a connection-wide service error other than token_expired", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);

    socket.fire(RealtimeEvent.Error, { code: RealtimeErrorCode.Internal });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect"]);
    expect(client.status()).toBe(RealtimeStatus.Open);
  });

  it("ignores a malformed service error", async () => {
    const { socket } = await startClient();
    await openConnection(socket);

    socket.fire(RealtimeEvent.Error, { nope: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect"]);
  });

  it("ignores a malformed drain hint", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);

    socket.fire(RealtimeEvent.Drain, { afterMs: "soon" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect"]);
    expect(client.status()).toBe(RealtimeStatus.Open);
  });

  it("ignores a drain hint after close", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    client.close();

    socket.fire(RealtimeEvent.Drain, { afterMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect", "disconnect"]);
  });

  it("ignores a refused handshake after close", async () => {
    const { socket, client, getToken } = await startClient();
    client.close();

    socket.refuse(RealtimeErrorCode.RateLimited);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.calls).toEqual(["connect", "disconnect"]);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("keeps reporting internal to a join after close when a protocol refusal follows", async () => {
    const { socket, client } = await startClient();
    client.close();

    socket.refuse(RealtimeErrorCode.UnknownKind);
    const onError = vi.fn();
    client.join("any", {
      onSignal: () => undefined,
      onResync: () => undefined,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(RealtimeErrorCode.Internal);
  });

  it("reports degraded on a reconnect attempt only after it was ever open", async () => {
    const { socket, client } = await startClient();

    socket.fireManager("reconnect_attempt");
    expect(client.status()).toBe(RealtimeStatus.Connecting);

    await openConnection(socket);
    socket.drop("transport close");
    expect(client.status()).toBe(RealtimeStatus.Degraded);
    socket.connected = true;
    socket.fire(RealtimeEvent.Welcome, {
      connectionId: "c",
      protocol: PROTOCOL_VERSION,
    });
    expect(client.status()).toBe(RealtimeStatus.Open);
    socket.fireManager("reconnect_attempt");
    expect(client.status()).toBe(RealtimeStatus.Degraded);
  });

  it("schedules no refresh for a connect that presented no token", async () => {
    const { socket, getToken } = await startClient();

    // Connected without the auth callback ever running, so no lifetime.
    socket.connected = true;
    socket.fire("connect");
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS * 2);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(0);
  });

  it("schedules no further refresh after a malformed refresh ack", async () => {
    const { socket, getToken } = await startClient();
    await openConnection(socket);
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS * 0.8);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(1);

    socket.ack(RealtimeEvent.Refresh, { ok: "yes" });
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS * 2);

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(socket.sent(RealtimeEvent.Refresh)).toHaveLength(1);
    expect(socket.calls).toEqual(["connect"]);
  });
});
