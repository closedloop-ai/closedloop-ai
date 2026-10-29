import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import {
  PROTOCOL_VERSION,
  RealtimeEvent,
  type WelcomePayload,
} from "@repo/realtime-contract/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPollLoop } from "../poll";
import { openConnection, settle, startClient } from "./client-harness";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CHANNEL = formatChannelAddress(ChannelKind.Comments, ORG, ["artifact-a"]);
const JOINED = { ok: true, channelId: "room-1" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startPollLoop", () => {
  it("waits 2, 4, 8, 16, 30, 30 s between polls", async () => {
    const startedAt = Date.now();
    const at: number[] = [];
    startPollLoop({
      poll: () => {
        at.push(Date.now() - startedAt);
        return Promise.resolve();
      },
      live: false,
    });

    await vi.advanceTimersByTimeAsync(90_000);

    expect(at).toEqual([2000, 6000, 14_000, 30_000, 60_000, 90_000]);
  });

  it("never starts a poll while one is in flight", async () => {
    let finish: () => void = () => undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const loop = startPollLoop({ poll, live: false });

    await vi.advanceTimersByTimeAsync(2000);
    loop.setLive(true);
    loop.setLive(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected or throwing poll to onError and keeps polling", async () => {
    const rejected = new Error("offline");
    const thrown = new Error("bug");
    const poll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(rejected)
      .mockImplementationOnce(() => {
        throw thrown;
      })
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    startPollLoop({ poll, onError, live: false });

    await vi.advanceTimersByTimeAsync(14_000);

    expect(poll).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls).toEqual([[rejected], [thrown]]);
  });

  it("keeps polling, with no unhandled rejection, when onError throws", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const poll = vi.fn(() => Promise.reject(new Error("offline")));
      const onError = vi.fn(() => {
        throw new Error("consumer bug");
      });
      const loop = startPollLoop({ poll, onError, live: false });

      await vi.advanceTimersByTimeAsync(6000);
      loop.stop();
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));

      expect(poll).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("stops while live, and restarts from 2 s once it is not", async () => {
    const poll = vi.fn(() => Promise.resolve());
    const loop = startPollLoop({ poll, live: false });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(poll).toHaveBeenCalledTimes(3);

    loop.setLive(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(3);

    loop.setLive(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("polls nothing once stopped", async () => {
    const poll = vi.fn(() => Promise.resolve());
    const loop = startPollLoop({ poll, live: false });

    loop.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(poll).not.toHaveBeenCalled();
  });

  it("does not report a poll that rejects after stop", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        })
    );
    const onError = vi.fn();
    const loop = startPollLoop({ poll, onError, live: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);

    loop.stop();
    fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(onError).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("createSocketIoRealtimeClient: poll fallback", () => {
  it("polls a channel until it is open and its join acknowledged, and again once it drops", async () => {
    const { socket, client } = await startClient();
    const poll = vi.fn(() => Promise.resolve());
    client.join(CHANNEL, listener(poll));

    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);

    await openConnection(socket);
    socket.ack(RealtimeEvent.Join, JOINED);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);

    socket.drop("transport close");
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps polling an acknowledged join until the client is open", async () => {
    const { socket, client } = await startClient();
    const poll = vi.fn(() => Promise.resolve());
    client.join(CHANNEL, listener(poll));
    await socket.handshake();
    socket.connected = true;
    socket.fire("connect");
    socket.ack(RealtimeEvent.Join, JOINED);

    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);

    const welcome: WelcomePayload = {
      connectionId: "conn-1",
      protocol: PROTOCOL_VERSION,
    };
    socket.fire(RealtimeEvent.Welcome, welcome);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("keeps polling a dropped channel until its leave", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const poll = vi.fn(() => Promise.resolve());
    const leave = client.join(CHANNEL, listener(poll));
    socket.ack(RealtimeEvent.Join, JOINED);

    socket.fire(RealtimeEvent.Error, {
      channel: CHANNEL,
      code: RealtimeErrorCode.Forbidden,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(1);

    leave();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("polls a channel joined on a closed client until its leave", async () => {
    const { client } = await startClient();
    client.close();
    const poll = vi.fn(() => Promise.resolve());
    const consumer = listener(poll);

    const leave = client.join(CHANNEL, consumer);
    await vi.advanceTimersByTimeAsync(2000);
    expect(consumer.onError).toHaveBeenCalledWith(RealtimeErrorCode.Internal);
    expect(poll).toHaveBeenCalledTimes(1);

    leave();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("sends a rejected poll to onPollError and polls again", async () => {
    const { client } = await startClient();
    await settle();
    const failure = new Error("offline");
    const poll = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const consumer = listener(poll);
    client.join(CHANNEL, consumer);

    await vi.advanceTimersByTimeAsync(6000);

    expect(consumer.onPollError).toHaveBeenCalledWith(failure);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

function listener(poll: () => Promise<void>) {
  return {
    onSignal: vi.fn(),
    onResync: vi.fn(),
    onError: vi.fn(),
    onPollError: vi.fn(),
    poll,
  };
}
