import assert from "node:assert/strict";
import { TraceFlags, trace } from "@opentelemetry/api";
import type { TransactionClient } from "@repo/database";
import { ChannelKind } from "@repo/realtime-contract/channels";
import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  parseSignalEnvelope,
  REALTIME_SIGNAL_CHANNEL,
} from "@repo/realtime-contract/signal";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { z } from "zod";
import {
  emitSignal,
  emitSignals,
  type SignalTypeRegistry,
} from "../emit-signal";

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHANNEL = `${ChannelKind.Comments}:${ORG_ID}:thread-1`;
const FIXTURE_TYPE = "fixture.changed";
const FIXTURE_REGISTRY: SignalTypeRegistry = {
  [ChannelKind.Comments]: {
    [FIXTURE_TYPE]: z.object({ id: z.string(), revision: z.number().int() }),
  },
};
const NOW_MS = 1_790_000_000_000;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("emitSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends one pg_notify on the signal channel carrying the envelope", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await emitSignal(
      tx,
      CHANNEL,
      { type: FIXTURE_TYPE, data: { id: "c1", revision: 3 } },
      FIXTURE_REGISTRY
    );

    assert.equal(executeRaw.mock.calls.length, 1);
    const [strings, channelName, payload] = executeRaw.mock.calls[0] ?? [];
    assert.match(String(strings?.join("?")), PG_NOTIFY_PATTERN);
    assert.equal(channelName, REALTIME_SIGNAL_CHANNEL);
    assert.deepEqual(JSON.parse(String(payload)), {
      c: CHANNEL,
      t: FIXTURE_TYPE,
      d: { id: "c1", revision: 3 },
      ts: NOW_MS,
    });
  });

  it("attaches the active span as a W3C traceparent", async () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(
      trace.wrapSpanContext({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: TraceFlags.SAMPLED,
      })
    );
    const { tx, executeRaw } = fakeTransaction();

    await emitSignal(
      tx,
      CHANNEL,
      { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
      FIXTURE_REGISTRY
    );

    const parsed = parseSignalEnvelope(String(executeRaw.mock.calls[0]?.[2]));
    assert.ok(parsed.success);
    assert.equal(parsed.envelope.tp, `00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("throws without notifying when the type is not declared for the kind", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignal(
        tx,
        CHANNEL,
        { type: "fixture.undeclared", data: {} },
        FIXTURE_REGISTRY
      ),
      UNDECLARED_TYPE_PATTERN
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });

  it("rejects a type the default registry does not declare", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignal(tx, CHANNEL, { type: FIXTURE_TYPE, data: {} }),
      UNDECLARED_TYPE_PATTERN
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });

  it("throws without notifying when data fails the type's schema", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignal(
        tx,
        CHANNEL,
        { type: FIXTURE_TYPE, data: { id: "c1", revision: "3" } },
        FIXTURE_REGISTRY
      )
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });

  it("throws without notifying when the envelope exceeds the byte cap", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignal(
        tx,
        CHANNEL,
        {
          type: FIXTURE_TYPE,
          data: { id: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES), revision: 1 },
        },
        FIXTURE_REGISTRY
      ),
      OVERSIZE_PATTERN
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });

  it("throws without notifying on a malformed channel address", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignal(
        tx,
        `${ChannelKind.Comments}:not-an-org:thread-1`,
        { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
        FIXTURE_REGISTRY
      ),
      INVALID_ADDRESS_PATTERN
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });
});

describe("emitSignals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("queues every signal in one ordered pg_notify statement", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await emitSignals(
      tx,
      [
        {
          channel: CHANNEL,
          signal: { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
        },
        {
          channel: SECOND_CHANNEL,
          signal: { type: FIXTURE_TYPE, data: { id: "c2", revision: 2 } },
        },
      ],
      FIXTURE_REGISTRY
    );

    assert.equal(executeRaw.mock.calls.length, 1);
    const [strings, channelName, payloads] = executeRaw.mock.calls[0] ?? [];
    assert.match(String(strings?.join("?")), PG_NOTIFY_BATCH_PATTERN);
    assert.equal(channelName, REALTIME_SIGNAL_CHANNEL);
    assert.ok(Array.isArray(payloads));
    assert.deepEqual(
      payloads.map((payload) => JSON.parse(String(payload))),
      [
        {
          c: CHANNEL,
          t: FIXTURE_TYPE,
          d: { id: "c1", revision: 1 },
          ts: NOW_MS,
        },
        {
          c: SECOND_CHANNEL,
          t: FIXTURE_TYPE,
          d: { id: "c2", revision: 2 },
          ts: NOW_MS,
        },
      ]
    );
  });

  it("sends no statement for an empty list", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await emitSignals(tx, [], FIXTURE_REGISTRY);

    assert.equal(executeRaw.mock.calls.length, 0);
  });

  it("notifies nothing when any one signal is invalid", async () => {
    const { tx, executeRaw } = fakeTransaction();

    await assert.rejects(
      emitSignals(
        tx,
        [
          {
            channel: CHANNEL,
            signal: { type: FIXTURE_TYPE, data: { id: "c1", revision: 1 } },
          },
          {
            channel: `${ChannelKind.Comments}:not-an-org:thread-2`,
            signal: { type: FIXTURE_TYPE, data: { id: "c2", revision: 2 } },
          },
        ],
        FIXTURE_REGISTRY
      ),
      INVALID_ADDRESS_PATTERN
    );
    assert.equal(executeRaw.mock.calls.length, 0);
  });
});

const SECOND_CHANNEL = `${ChannelKind.Comments}:${ORG_ID}:thread-2`;
const PG_NOTIFY_PATTERN = /^SELECT pg_notify\(\?, \?\)$/;
const PG_NOTIFY_BATCH_PATTERN =
  /^SELECT pg_notify\(\?, payload\) FROM unnest\(\?::text\[\]\) WITH ORDINALITY AS signal\(payload, position\) ORDER BY position$/;
const UNDECLARED_TYPE_PATTERN = /is not declared for channel kind/;
const OVERSIZE_PATTERN = /the limit is/;
const INVALID_ADDRESS_PATTERN = /Invalid realtime channel address/;

function fakeTransaction() {
  const executeRaw = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(1)
  );
  const tx = { $executeRaw: executeRaw } as unknown as TransactionClient;
  return { tx, executeRaw };
}
