import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { RealtimeChannelListener, RealtimeSignal } from "../port";
import { openConnection, startClient } from "./client-harness";
import { ackPacket, type FakeSocket } from "./fake-socket";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CHANNEL_A = formatChannelAddress(ChannelKind.Comments, ORG, [
  "artifact-a",
]);
const CHANNEL_B = formatChannelAddress(ChannelKind.Comments, ORG, [
  "artifact-b",
]);
const JOINED = { ok: true, channelId: "room-1" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSocketIoRealtimeClient: channels", () => {
  it("sends one rt:join for two consumers of one address, and one rt:leave after the last leaves", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);

    const leaveFirst = client.join(CHANNEL_A, listener());
    const leaveSecond = client.join(CHANNEL_A, listener());
    expect(joinsFor(socket, CHANNEL_A)).toBe(1);

    leaveFirst();
    leaveFirst();
    expect(socket.sent(RealtimeEvent.Leave)).toHaveLength(0);
    leaveSecond();
    expect(socket.sent(RealtimeEvent.Leave)).toEqual([
      { event: RealtimeEvent.Leave, args: [{ channel: CHANNEL_A }] },
    ]);
  });

  it("sends a join made while disconnected exactly once, on connect", async () => {
    const { socket, client } = await startClient();

    client.join(CHANNEL_A, listener());
    expect(socket.emitted).toHaveLength(0);

    await openConnection(socket);
    expect(joinsFor(socket, CHANNEL_A)).toBe(1);
  });

  it("rejoins every held channel after a reconnect", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    client.join(CHANNEL_A, listener());
    socket.ack(RealtimeEvent.Join, JOINED);
    client.join(CHANNEL_B, listener());
    socket.ack(RealtimeEvent.Join, JOINED);

    socket.drop("transport close");
    expect(socket.sent(RealtimeEvent.Join)).toHaveLength(2);
    await openConnection(socket);

    expect(joinsFor(socket, CHANNEL_A)).toBe(2);
    expect(joinsFor(socket, CHANNEL_B)).toBe(2);
  });

  it("resyncs a listener whose data is missing or older than the join ack, not one loaded after it", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const ackAt = Date.now() + 1000;
    const unloaded = listener({ dataLoadedAt: () => undefined });
    const older = listener({ dataLoadedAt: () => ackAt - 1 });
    const newer = listener({ dataLoadedAt: () => ackAt + 1 });
    client.join(CHANNEL_A, unloaded);
    client.join(CHANNEL_A, older);
    client.join(CHANNEL_A, newer);

    vi.setSystemTime(ackAt);
    socket.ack(RealtimeEvent.Join, JOINED);

    expect(unloaded.onResync).toHaveBeenCalledTimes(1);
    expect(older.onResync).toHaveBeenCalledTimes(1);
    expect(newer.onResync).not.toHaveBeenCalled();
  });

  it("runs the resync rule again on every rejoin ack", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener();
    client.join(CHANNEL_A, consumer);
    socket.ack(RealtimeEvent.Join, JOINED);

    socket.drop("transport close");
    await openConnection(socket);
    socket.ack(RealtimeEvent.Join, JOINED);

    expect(consumer.onResync).toHaveBeenCalledTimes(2);
  });

  it("applies the resync rule to a listener added to a joined channel as of when it joined", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    client.join(CHANNEL_A, listener());
    socket.ack(RealtimeEvent.Join, JOINED);
    vi.setSystemTime(Date.now() + 5000);

    const stale = listener({ dataLoadedAt: () => Date.now() - 1 });
    const fresh = listener({ dataLoadedAt: () => Date.now() });
    client.join(CHANNEL_A, stale);
    client.join(CHANNEL_A, fresh);

    expect(stale.onResync).toHaveBeenCalledTimes(1);
    expect(fresh.onResync).not.toHaveBeenCalled();
    expect(joinsFor(socket, CHANNEL_A)).toBe(1);
  });

  it("delivers rt:resync to the named channel, or to every channel when none is named", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const onA = listener({ dataLoadedAt: () => Number.MAX_SAFE_INTEGER });
    const onB = listener({ dataLoadedAt: () => Number.MAX_SAFE_INTEGER });
    client.join(CHANNEL_A, onA);
    client.join(CHANNEL_B, onB);

    socket.fire(RealtimeEvent.Resync, { channel: CHANNEL_A });
    expect(onA.onResync).toHaveBeenCalledTimes(1);
    expect(onB.onResync).not.toHaveBeenCalled();

    socket.fire(RealtimeEvent.Resync, {});
    expect(onA.onResync).toHaveBeenCalledTimes(2);
    expect(onB.onResync).toHaveBeenCalledTimes(1);
  });

  it("drops a revoked channel, reports forbidden, and never rejoins it", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener();
    const leave = client.join(CHANNEL_A, consumer);
    socket.ack(RealtimeEvent.Join, JOINED);

    socket.fire(RealtimeEvent.Error, {
      channel: CHANNEL_A,
      code: RealtimeErrorCode.Forbidden,
    });
    expect(consumer.onError).toHaveBeenCalledWith(RealtimeErrorCode.Forbidden);

    signal(socket, CHANNEL_A, "comment.created");
    expect(consumer.onSignal).not.toHaveBeenCalled();
    leave();
    expect(socket.sent(RealtimeEvent.Leave)).toHaveLength(0);
    socket.drop("transport close");
    await openConnection(socket);
    expect(joinsFor(socket, CHANNEL_A)).toBe(1);
  });

  it.each([
    [RealtimeErrorCode.Forbidden, RealtimeErrorCode.Forbidden],
    [RealtimeErrorCode.UnknownKind, RealtimeErrorCode.UnknownKind],
    [RealtimeErrorCode.BadScope, RealtimeErrorCode.BadScope],
    [RealtimeErrorCode.Unauthorized, RealtimeErrorCode.Unauthorized],
    [RealtimeErrorCode.PayloadTooLarge, RealtimeErrorCode.PayloadTooLarge],
    [RealtimeErrorCode.TokenExpired, RealtimeErrorCode.TokenExpired],
    [RealtimeErrorCode.Internal, RealtimeErrorCode.Internal],
    ["a_code_from_a_newer_service", RealtimeErrorCode.Internal],
  ])(
    "drops a channel whose join is acked %s and reports %s",
    async (code, reported) => {
      const { socket, client } = await startClient();
      await openConnection(socket);
      const consumer = listener();
      client.join(CHANNEL_A, consumer);

      socket.ack(RealtimeEvent.Join, { ok: false, code });

      expect(consumer.onError).toHaveBeenCalledWith(reported);
      expect(consumer.onResync).not.toHaveBeenCalled();
      socket.drop("transport close");
      await openConnection(socket);
      expect(joinsFor(socket, CHANNEL_A)).toBe(1);
    }
  );

  it("retries a rate-limited join after 2 s, then 4 s", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener();
    client.join(CHANNEL_A, consumer);

    socket.ack(RealtimeEvent.Join, {
      ok: false,
      code: RealtimeErrorCode.RateLimited,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(joinsFor(socket, CHANNEL_A)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(joinsFor(socket, CHANNEL_A)).toBe(2);

    socket.ack(RealtimeEvent.Join, {
      ok: false,
      code: RealtimeErrorCode.RateLimited,
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(joinsFor(socket, CHANNEL_A)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(joinsFor(socket, CHANNEL_A)).toBe(3);

    socket.ack(RealtimeEvent.Join, JOINED);
    expect(consumer.onResync).toHaveBeenCalledTimes(1);
    expect(consumer.onError).not.toHaveBeenCalled();
  });

  it("hands a signal of a type it has never seen to the listener unchanged", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const onA = listener();
    const onB = listener();
    client.join(CHANNEL_A, onA);
    client.join(CHANNEL_B, onB);

    signal(socket, CHANNEL_A, "brand.new-type", { id: "x", rev: 3 });

    expect(onA.onSignal).toHaveBeenCalledWith({
      type: "brand.new-type",
      data: { id: "x", rev: 3 },
    });
    expect(onB.onSignal).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener({ dataLoadedAt: () => Number.MAX_SAFE_INTEGER });
    client.join(CHANNEL_A, consumer);

    socket.fire(RealtimeEvent.Signal, { channel: CHANNEL_A });
    socket.fire(RealtimeEvent.Resync, "everything");
    socket.fire(RealtimeEvent.Error, { channel: CHANNEL_A });

    expect(consumer.onSignal).not.toHaveBeenCalled();
    expect(consumer.onResync).not.toHaveBeenCalled();
    expect(consumer.onError).not.toHaveBeenCalled();
  });

  it("ignores a join ack from before a reconnect", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener();
    client.join(CHANNEL_A, consumer);
    const [beforeDrop] = socket.sent(RealtimeEvent.Join);

    socket.drop("transport close");
    await openConnection(socket);
    if (beforeDrop === undefined) {
      throw new Error("no join was sent");
    }
    ackPacket(beforeDrop, {
      ok: false,
      code: RealtimeErrorCode.Forbidden,
    });

    expect(consumer.onError).not.toHaveBeenCalled();
    socket.ack(RealtimeEvent.Join, JOINED);
    expect(consumer.onResync).toHaveBeenCalledTimes(1);
  });

  it("sends rt:leave for a join still awaiting its ack, and ignores that ack", async () => {
    const { socket, client } = await startClient();
    await openConnection(socket);
    const consumer = listener();
    const leave = client.join(CHANNEL_A, consumer);

    leave();
    socket.ack(RealtimeEvent.Join, JOINED);

    expect(socket.sent(RealtimeEvent.Leave)).toHaveLength(1);
    expect(consumer.onResync).not.toHaveBeenCalled();
  });
});

type MockListener = {
  onSignal: Mock<(signal: RealtimeSignal) => void>;
  onResync: Mock<() => void>;
  onError: Mock<(code: RealtimeErrorCode) => void>;
  dataLoadedAt?: () => number | undefined;
};

function listener(
  dataLoadedAt?: Pick<RealtimeChannelListener, "dataLoadedAt">
): MockListener {
  return {
    onSignal: vi.fn<(signal: RealtimeSignal) => void>(),
    onResync: vi.fn<() => void>(),
    onError: vi.fn<(code: RealtimeErrorCode) => void>(),
    ...dataLoadedAt,
  };
}

function joinsFor(socket: FakeSocket, channel: string): number {
  return socket.sent(RealtimeEvent.Join).filter((packet) => {
    const [payload] = packet.args;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "channel" in payload &&
      payload.channel === channel
    );
  }).length;
}

function signal(
  socket: FakeSocket,
  channel: string,
  type: string,
  data: unknown = {}
): void {
  socket.fire(RealtimeEvent.Signal, { channel, type, data });
}
