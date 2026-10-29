/**
 * PLN-2103 Step 7: `emitSignal` against a real Postgres. Postgres delivers
 * NOTIFY in commit order, so a sentinel emitted in a LATER committed
 * transaction arriving proves that anything the earlier transaction would have
 * delivered has already arrived. That is what lets the "delivers nothing" cases
 * assert absence without a fixed wait.
 */
import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { ChannelKind } from "@repo/realtime-contract/channels";
import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  parseSignalEnvelope,
  REALTIME_SIGNAL_CHANNEL,
  type SignalEnvelope,
} from "@repo/realtime-contract/signal";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import {
  emitSignal,
  type SignalTypeRegistry,
} from "@repo/realtime-server/emit-signal";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const FIXTURE_TYPE = "fixture.changed";
const FIXTURE_SCHEMA = z.object({ id: z.string(), revision: z.number().int() });
/** The document-versions entry only carries the sentinel; its cases use the shipped registry. */
const FIXTURE_REGISTRY: SignalTypeRegistry = {
  [ChannelKind.Comments]: { [FIXTURE_TYPE]: FIXTURE_SCHEMA },
  [ChannelKind.DocumentVersions]: { [FIXTURE_TYPE]: FIXTURE_SCHEMA },
};
const ORG_ID = randomUUID();
const NOTIFICATION_WAIT_MS = 5000;
const ROLLBACK = new Error("rollback requested by test");

type Received = { channel: string; envelope: SignalEnvelope | null };

describeIfDb("emitSignal (real Postgres)", () => {
  let listener: Client;
  const received: Received[] = [];

  beforeAll(async () => {
    listener = new Client({ connectionString: keys().DATABASE_URL });
    await listener.connect();
    listener.on("notification", (message) => {
      const parsed = parseSignalEnvelope(message.payload ?? "");
      received.push({
        channel: message.channel,
        envelope: parsed.success ? parsed.envelope : null,
      });
    });
    await listener.query(`LISTEN ${REALTIME_SIGNAL_CHANNEL}`);
  });

  afterAll(async () => {
    await listener?.end();
  });

  it("delivers exactly one notification for a committed transaction", async () => {
    const channel = uniqueChannel();

    await withDb.tx((tx) =>
      emitSignal(
        tx,
        channel,
        { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
        FIXTURE_REGISTRY
      )
    );
    await emitSentinel(channel);

    expect(await signalsUntilSentinel(channel)).toEqual([
      expect.objectContaining({
        c: channel,
        t: FIXTURE_TYPE,
        d: { id: "c1", revision: 1 },
      }),
    ]);
  });

  it("delivers nothing for a rolled-back transaction", async () => {
    const channel = uniqueChannel();

    await expect(
      withDb.tx(async (tx) => {
        await emitSignal(
          tx,
          channel,
          { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
          FIXTURE_REGISTRY
        );
        throw ROLLBACK;
      })
    ).rejects.toBe(ROLLBACK);
    await emitSentinel(channel);

    expect(await signalsUntilSentinel(channel)).toEqual([]);
  });

  it("throws on an oversized payload and rolls back the whole transaction", async () => {
    const channel = uniqueChannel();

    await expect(
      withDb.tx(async (tx) => {
        await emitSignal(
          tx,
          channel,
          { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
          FIXTURE_REGISTRY
        );
        await emitSignal(
          tx,
          channel,
          {
            type: FIXTURE_TYPE,
            data: { id: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES), revision: 2 },
          },
          FIXTURE_REGISTRY
        );
      })
    ).rejects.toThrow();
    await emitSentinel(channel);

    expect(await signalsUntilSentinel(channel)).toEqual([]);
  });

  it("throws on a type not declared for the kind and rolls back the whole transaction", async () => {
    const channel = uniqueChannel();

    await expect(
      withDb.tx(async (tx) => {
        await emitSignal(
          tx,
          channel,
          { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
          FIXTURE_REGISTRY
        );
        await emitSignal(
          tx,
          channel,
          { type: "fixture.undeclared", data: { id: "c1" } },
          FIXTURE_REGISTRY
        );
      })
    ).rejects.toThrow();
    await emitSentinel(channel);

    expect(await signalsUntilSentinel(channel)).toEqual([]);
  });

  it("delivers version.published on a document-versions channel through the shipped registry", async () => {
    const channel = `${ChannelKind.DocumentVersions}:${ORG_ID}:${randomUUID()}`;

    await withDb.tx((tx) =>
      emitSignal(tx, channel, {
        type: DocumentVersionSignalType.Published,
        data: { version: 3 },
      })
    );
    await emitSentinel(channel);

    expect(await signalsUntilSentinel(channel)).toEqual([
      expect.objectContaining({
        c: channel,
        t: DocumentVersionSignalType.Published,
        d: { version: 3 },
      }),
    ]);
  });

  it.each([0, 1.5])(
    "refuses version.published with version %s",
    async (version) => {
      const channel = `${ChannelKind.DocumentVersions}:${ORG_ID}:${randomUUID()}`;

      await expect(
        withDb.tx((tx) =>
          emitSignal(tx, channel, {
            type: DocumentVersionSignalType.Published,
            data: { version },
          })
        )
      ).rejects.toThrow();
    }
  );

  function uniqueChannel(): string {
    return `${ChannelKind.Comments}:${ORG_ID}:${randomUUID()}`;
  }

  /** Commits a notification marking the end of `channel`'s traffic. */
  function emitSentinel(channel: string): Promise<void> {
    return withDb.tx((tx) =>
      emitSignal(
        tx,
        channel,
        { type: FIXTURE_TYPE, data: { id: SENTINEL_ID, revision: 0 } },
        FIXTURE_REGISTRY
      )
    );
  }

  /** Envelopes delivered on `channel` before its sentinel, sentinel excluded. */
  async function signalsUntilSentinel(
    channel: string
  ): Promise<SignalEnvelope[]> {
    const deadline = Date.now() + NOTIFICATION_WAIT_MS;
    while (!received.some((entry) => isSentinelFor(entry, channel))) {
      if (Date.now() > deadline) {
        throw new Error(`No sentinel notification arrived for ${channel}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return received.flatMap((entry) =>
      entry.channel === REALTIME_SIGNAL_CHANNEL &&
      entry.envelope?.c === channel &&
      !isSentinelFor(entry, channel)
        ? [entry.envelope]
        : []
    );
  }
});

const SENTINEL_ID = "sentinel";
const POLL_INTERVAL_MS = 20;

const SENTINEL_DATA = z.object({ id: z.literal(SENTINEL_ID) });

function isSentinelFor(entry: Received, channel: string): boolean {
  return (
    entry.envelope?.c === channel &&
    SENTINEL_DATA.safeParse(entry.envelope.d).success
  );
}
