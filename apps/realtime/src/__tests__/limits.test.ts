import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
import type { Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIGNAL_FLOOD_MAX_REFUSALS,
  SIGNAL_FLOOD_WINDOW_MS,
  SIGNAL_MAX_BUFFERED_PACKETS,
  SIGNAL_MESSAGE_BURST,
  SIGNAL_MESSAGE_REFILL_PER_SECOND,
} from "../classes/signal";
import { bufferedPacketCount } from "../limits/slow-client";
import {
  type EdgeHarness,
  emitWithAck,
  nextEvent,
  ORG_A,
  startEdge,
  tokenFor,
  USER_A,
  welcomedClient,
} from "./edge-harness";

const CHANNEL = `comments:${ORG_A}:doc-1`;
const RATE_LIMITED = { ok: false, code: RealtimeErrorCode.RateLimited };
const MS_PER_TOKEN = 1000 / SIGNAL_MESSAGE_REFILL_PER_SECOND;
const DISCONNECT_WAIT_MS = 2000;
/** Outside the `rt:` prefix, so it has no handler and no answer. */
const UNPREFIXED_EVENT = "x";
/** A socket.io EVENT packet (type 2) on the default namespace, event name `1`. */
const NUMERIC_EVENT_PACKET = `2${JSON.stringify([1, {}])}`;

describe("limits on a live connection", () => {
  let edge: EdgeHarness;
  const clients: ClientSocket[] = [];
  // Frozen unless a test moves it, so the bucket never refills mid-test.
  let nowMs = 0;

  beforeEach(async () => {
    nowMs = Date.now();
    edge = await startEdge({ now: () => nowMs });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await edge.close();
  });

  async function connected(): Promise<ClientSocket> {
    const { client } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );
    return client;
  }

  function spendBurst(client: ClientSocket, count = SIGNAL_MESSAGE_BURST) {
    return Promise.all(
      Array.from({ length: count }, () =>
        emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
      )
    );
  }

  /**
   * Sends `count` events past an empty bucket. Only the last is acked, so the
   * server has handled every one of them when it resolves.
   */
  function refuse(client: ClientSocket, count: number) {
    for (let sent = 0; sent < count - 1; sent += 1) {
      client.emit(UNPREFIXED_EVENT, {});
    }
    return emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL });
  }

  it("acks every event inside the burst and rate_limited past it", async () => {
    const client = await connected();

    const acks = await spendBurst(client);

    expect(acks.every((ack) => (ack as { ok: boolean }).ok)).toBe(true);
    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual(RATE_LIMITED);
    expect(client.connected).toBe(true);
  });

  it("counts rt:refresh and events with no handler against the same bucket", async () => {
    const client = await connected();
    for (let sent = 0; sent < SIGNAL_MESSAGE_BURST - 1; sent += 1) {
      client.emit("rt:from-the-future", {});
    }
    await spendBurst(client, 1);

    expect(
      await emitWithAck(client, RealtimeEvent.Refresh, {
        token: await tokenFor(ORG_A, USER_A),
      })
    ).toEqual(RATE_LIMITED);
  });

  it("counts events outside the rt: prefix against the same bucket", async () => {
    const client = await connected();
    for (let sent = 0; sent < SIGNAL_MESSAGE_BURST; sent += 1) {
      client.emit(UNPREFIXED_EVENT, {});
    }

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual(RATE_LIMITED);
  });

  it("disconnects a socket refused the flood threshold of events within the window", async () => {
    const client = await connected();
    await spendBurst(client);
    const received: unknown[] = [];
    client.on(RealtimeEvent.Error, (payload: unknown) =>
      received.push(payload)
    );
    client.on("disconnect", (reason) => received.push(reason));

    for (let sent = 0; sent < SIGNAL_FLOOD_MAX_REFUSALS; sent += 1) {
      client.emit(UNPREFIXED_EVENT, {});
    }

    await vi.waitFor(
      () =>
        expect(received).toEqual([
          { code: RealtimeErrorCode.RateLimited },
          "io server disconnect",
        ]),
      { timeout: DISCONNECT_WAIT_MS }
    );
  });

  it("keeps a socket refused one event short of the flood threshold", async () => {
    const client = await connected();
    await spendBurst(client);

    expect(await refuse(client, SIGNAL_FLOOD_MAX_REFUSALS - 1)).toEqual(
      RATE_LIMITED
    );
    expect(client.connected).toBe(true);
  });

  it("starts the refusal count over once the window closes", async () => {
    const client = await connected();
    await spendBurst(client);
    await refuse(client, SIGNAL_FLOOD_MAX_REFUSALS - 1);

    nowMs += SIGNAL_FLOOD_WINDOW_MS;
    await spendBurst(client, SIGNAL_FLOOD_WINDOW_MS / MS_PER_TOKEN);

    expect(await refuse(client, SIGNAL_FLOOD_MAX_REFUSALS - 1)).toEqual(
      RATE_LIMITED
    );
    expect(client.connected).toBe(true);
  });

  it("answers an unacked event past the limit with rt:error", async () => {
    const client = await connected();
    await spendBurst(client);
    const refused = nextEvent<unknown>(client, RealtimeEvent.Error);

    client.emit(RealtimeEvent.Join, { channel: CHANNEL });

    expect(await refused).toEqual({ code: RealtimeErrorCode.RateLimited });
  });

  it("keeps a socket whose write buffer reaches the threshold", async () => {
    const client = await connected();
    const socket = edge.io.of("/").sockets.get(client.id ?? "");

    // engine.io 6.6 keeps the buffer the slow-client check reads.
    expect(Array.isArray(Reflect.get(socket?.conn ?? {}, "writeBuffer"))).toBe(
      true
    );
    // The first packet goes straight to the transport; the rest queue
    // behind its pending write, filling the buffer to exactly the threshold.
    for (let sent = 0; sent <= SIGNAL_MAX_BUFFERED_PACKETS; sent += 1) {
      socket?.emit("load", sent);
    }
    expect(bufferedPacketCount(socket?.conn ?? {})).toBe(
      SIGNAL_MAX_BUFFERED_PACKETS
    );

    expect(
      await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
    ).toEqual({ ok: true });
  });

  it("survives a raw event packet whose name is a number", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const client = await connected();

      // The engine adds the `4` message prefix, so the wire frame is `42[1,{}]`.
      client.io.engine.send(NUMERIC_EVENT_PACKET);

      expect(
        await emitWithAck(client, RealtimeEvent.Leave, { channel: CHANNEL })
      ).toEqual({ ok: true });
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("drops a socket whose write buffer passes the threshold, as a transport close", async () => {
    const client = await connected();
    const socket = edge.io.of("/").sockets.get(client.id ?? "");
    const disconnected = nextEvent<string>(client, "disconnect");

    for (let sent = 0; sent <= SIGNAL_MAX_BUFFERED_PACKETS + 1; sent += 1) {
      socket?.emit("load", sent);
    }

    // A transport close, not a server disconnect: the client reconnects.
    expect(await disconnected).toBe("transport close");
  });
});
