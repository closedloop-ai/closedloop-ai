import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { log } from "@repo/observability/log";
import { type Grant, GrantAccess } from "@repo/realtime-contract/grants";
import {
  RealtimeEvent,
  type ResyncPayload,
  type SignalPayload,
} from "@repo/realtime-contract/protocol";
import { SignalEnvelopeRejection } from "@repo/realtime-contract/signal";
import pg from "pg";
import type { Socket as ClientSocket } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createReadiness, Dependency } from "../lifecycle/readiness";
import {
  LISTENER_UNCONFIGURED_EVENT,
  startConfiguredSignalDelivery,
  startSignalDelivery,
} from "../signal/delivery";
import {
  createSignalFanOut,
  SIGNAL_DELAY_SAMPLES_PER_MINUTE,
  SIGNAL_DROPPED_EVENT,
} from "../signal/fanout";
import type { SignalListener } from "../signal/listener";
import { ListenerAuth } from "../signal/listener-config";
import { resyncAll } from "../signal/runtime";
import { RealtimeCount, RealtimeHistogram } from "../telemetry/gauges";
import {
  FanOutOutcome,
  RealtimeSpan,
  RealtimeSpanAttribute,
  ResyncCause,
} from "../telemetry/spans";
import {
  type EdgeHarness,
  emitWithAck,
  grantedTokenFor,
  nextEvent,
  ORG_A,
  startComposedEdge,
  USER_A,
  USER_B,
  welcomedClient,
} from "./edge-harness";
import { fakeClientFactory } from "./fake-listener-client";

/** A kind and a signal type no code in the service names. */
const PROBE = `probe:${ORG_A}:x`;
const PROBE_TYPE = "probe.fired";
const DOC_1 = `comments:${ORG_A}:doc-1`;
const ORG_A_ALL: Grant[] = [
  { pattern: `comments:${ORG_A}:*`, access: GrantAccess.Read },
  { pattern: PROBE, access: GrantAccess.Read },
];
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  trace.disable();
  await provider.shutdown();
});

let edge: EdgeHarness;
let listener: SignalListener | undefined;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  exporter.reset();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  edge = await startComposedEdge();
});

afterEach(async () => {
  await listener?.stop();
  listener = undefined;
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await edge.close();
  vi.restoreAllMocks();
});

async function joinedClient(
  sub: string,
  channels: string[]
): Promise<ClientSocket> {
  const { client } = await welcomedClient(
    edge.url,
    await grantedTokenFor(ORG_A, sub, ORG_A_ALL),
    clients
  );
  for (const channel of channels) {
    await emitWithAck(client, RealtimeEvent.Join, { channel });
  }
  return client;
}

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({
    c: DOC_1,
    t: "comment.created",
    d: {},
    ts: 1,
    ...fields,
  });
}

/** Every event a client received, in order. */
function record(client: ClientSocket): [string, unknown][] {
  const received: [string, unknown][] = [];
  client.onAny((event: string, payload: unknown) => {
    received.push([event, payload]);
  });
  return received;
}

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

describe("signal fan-out", () => {
  it("delivers an unseen kind and type to a granted subscriber with type and data unchanged, and never ts or tp", async () => {
    const client = await joinedClient(USER_A, [PROBE]);
    const fanOut = createSignalFanOut(edge.io, () => 1500);
    const data = { nested: { list: [1, "two", null], flag: true }, n: 1.5 };
    const received = nextEvent<SignalPayload>(client, RealtimeEvent.Signal);

    fanOut(
      JSON.stringify({
        c: PROBE,
        t: PROBE_TYPE,
        d: data,
        ts: 1000,
        tp: `00-${TRACE_ID}-${SPAN_ID}-01`,
      })
    );

    const signal = await received;
    expect(signal).toEqual({ channel: PROBE, type: PROBE_TYPE, data });
    expect(JSON.stringify(signal.data)).toBe(JSON.stringify(data));
    expect(Object.keys(signal).sort()).toEqual(["channel", "data", "type"]);
  });

  it("reaches only the room addressed", async () => {
    const inDoc = await joinedClient(USER_A, [DOC_1]);
    const inProbe = await joinedClient(USER_B, [PROBE]);
    const docEvents = record(inDoc);
    const fanOut = createSignalFanOut(edge.io);

    const probeReceived = nextEvent(inProbe, RealtimeEvent.Signal);
    fanOut(envelope({ c: PROBE, t: PROBE_TYPE }));
    await probeReceived;
    // Same socket, same order: the sentinel arrives after anything sent before it.
    const sentinel = nextEvent(inDoc, RealtimeEvent.Signal);
    fanOut(envelope({ t: "sentinel" }));
    await sentinel;

    expect(docEvents.map(([, payload]) => payload)).toEqual([
      { channel: DOC_1, type: "sentinel", data: {} },
    ]);
  });

  it("drops a malformed envelope with a warning that carries its size and never its content", async () => {
    const client = await joinedClient(USER_A, [DOC_1]);
    const events = record(client);
    const fanOut = createSignalFanOut(edge.io);
    const secret = "do-not-log-this-content";
    const missingField = JSON.stringify({ c: DOC_1, d: { secret }, ts: 1 });
    const badType = envelope({ t: "Not A Type", d: { secret } });

    fanOut(missingField);
    fanOut(badType);
    const sentinel = nextEvent(client, RealtimeEvent.Signal);
    fanOut(envelope({ t: "sentinel" }));
    await sentinel;

    expect(events.map(([event, payload]) => [event, payload])).toEqual([
      [RealtimeEvent.Signal, { channel: DOC_1, type: "sentinel", data: {} }],
    ]);
    const dropped = vi
      .mocked(log.warn)
      .mock.calls.filter(([, meta]) =>
        JSON.stringify(meta).includes(SIGNAL_DROPPED_EVENT)
      );
    expect(dropped.map(([, meta]) => meta)).toEqual([
      {
        event: SIGNAL_DROPPED_EVENT,
        reason: SignalEnvelopeRejection.Malformed,
        bytes: Buffer.byteLength(missingField),
      },
      {
        event: SIGNAL_DROPPED_EVENT,
        reason: SignalEnvelopeRejection.Malformed,
        bytes: Buffer.byteLength(badType),
      },
    ]);
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(
      secret
    );
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))
    ).not.toContain(secret);
  });

  it("records one fan-out span per notification, a child of tp's span, with recipients, kind, type, outcome and emit-to-delivery", async () => {
    await joinedClient(USER_A, [PROBE]);
    await joinedClient(USER_B, [PROBE]);
    const metric = vi.mocked(log.info);
    const fanOut = createSignalFanOut(edge.io, () => 1250);

    fanOut(
      JSON.stringify({
        c: PROBE,
        t: PROBE_TYPE,
        d: null,
        ts: 1000,
        tp: `00-${TRACE_ID}-${SPAN_ID}-01`,
      })
    );
    fanOut(envelope({ c: `probe:${ORG_A}:empty`, ts: 2000 }));

    const [delivered, unheard] = spansNamed(RealtimeSpan.SignalFanOut);
    expect(delivered?.attributes).toEqual({
      [RealtimeSpanAttribute.Outcome]: FanOutOutcome.Delivered,
      [RealtimeSpanAttribute.Recipients]: 2,
      [RealtimeSpanAttribute.ChannelKind]: "probe",
      [RealtimeSpanAttribute.SignalType]: PROBE_TYPE,
      [RealtimeSpanAttribute.EmitToDeliveryMs]: 250,
      [RealtimeSpanAttribute.TraceparentSampled]: true,
    });
    expect(delivered?.spanContext().traceId).toBe(TRACE_ID);
    expect(delivered?.parentSpanContext?.spanId).toBe(SPAN_ID);
    expect(unheard?.attributes).toEqual(
      expect.objectContaining({
        [RealtimeSpanAttribute.Outcome]: FanOutOutcome.NoRecipients,
        [RealtimeSpanAttribute.Recipients]: 0,
      })
    );
    expect(unheard?.attributes).not.toHaveProperty(
      RealtimeSpanAttribute.EmitToDeliveryMs
    );
    const samples = metric.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes(RealtimeHistogram.SignalEmitToDeliveryMs)
      )
      .map((message) => JSON.parse(message).value);
    expect(samples).toEqual([250]);
  });

  it("logs at most SIGNAL_DELAY_SAMPLES_PER_MINUTE delay samples per clock minute and still records a span for every fan-out", () => {
    let clock = 60_000;
    const fanOut = createSignalFanOut(edge.io, () => clock);

    for (let i = 0; i <= SIGNAL_DELAY_SAMPLES_PER_MINUTE; i += 1) {
      fanOut(envelope({ ts: 60_000 - i }));
    }
    clock = 119_999;
    fanOut(envelope({ ts: 119_000 }));
    expect(delaySamples()).toEqual(
      Array.from({ length: SIGNAL_DELAY_SAMPLES_PER_MINUTE }, (_, i) => i)
    );

    clock = 120_000;
    fanOut(envelope({ ts: 119_000 }));
    expect(delaySamples().at(-1)).toBe(1000);
    expect(delaySamples()).toHaveLength(SIGNAL_DELAY_SAMPLES_PER_MINUTE + 1);
    expect(spansNamed(RealtimeSpan.SignalFanOut)).toHaveLength(
      SIGNAL_DELAY_SAMPLES_PER_MINUTE + 3
    );
  });

  it("logs the delay sample of every fan-out that reached a socket, past the per-minute cap and without counting against it", async () => {
    await joinedClient(USER_A, [DOC_1]);
    const fanOut = createSignalFanOut(edge.io, () => 60_000);

    fanOut(envelope({ ts: 59_000 }));
    for (let i = 0; i <= SIGNAL_DELAY_SAMPLES_PER_MINUTE; i += 1) {
      fanOut(envelope({ c: `probe:${ORG_A}:empty`, ts: 60_000 }));
    }
    fanOut(envelope({ ts: 59_500 }));

    expect(delaySamples()).toEqual([
      1000,
      ...Array.from({ length: SIGNAL_DELAY_SAMPLES_PER_MINUTE }, () => 0),
      500,
    ]);
  });

  it("records tp's sampled flag on the fan-out span, and records the span in tp's trace whatever the flag", async () => {
    await joinedClient(USER_A, [DOC_1]);
    const fanOut = createSignalFanOut(edge.io);

    fanOut(envelope({ tp: `00-${TRACE_ID}-${SPAN_ID}-01` }));
    fanOut(envelope({ tp: `00-${TRACE_ID}-${SPAN_ID}-00` }));
    fanOut(envelope({ tp: "not-a-traceparent" }));

    const spans = spansNamed(RealtimeSpan.SignalFanOut);
    expect(
      spans.map(
        (span) => span.attributes[RealtimeSpanAttribute.TraceparentSampled]
      )
    ).toEqual([true, false, undefined]);
    expect(spans.map((span) => span.parentSpanContext?.spanId)).toEqual([
      SPAN_ID,
      SPAN_ID,
      undefined,
    ]);
    const [sampled, unsampled, untraced] = spans;
    expect(sampled?.spanContext().traceId).toBe(TRACE_ID);
    expect(unsampled?.spanContext().traceId).toBe(TRACE_ID);
    expect(untraced?.spanContext().traceId).not.toBe(TRACE_ID);
  });
});

describe("resync", () => {
  it("emits rt:resync {} once to each socket holding a signal room, and to no other", async () => {
    const twoRooms = await joinedClient(USER_A, [DOC_1, PROBE]);
    const noRooms = await joinedClient(USER_B, []);
    const twoRoomsEvents = record(twoRooms);
    const noRoomEvents = record(noRooms);

    expect(resyncAll(edge.io)).toBe(1);
    await nextEvent<ResyncPayload>(twoRooms, RealtimeEvent.Resync);
    // An acked round trip: any resync sent to this socket arrives before it.
    await emitWithAck(noRooms, RealtimeEvent.Leave, { channel: DOC_1 });

    expect(twoRoomsEvents).toEqual([[RealtimeEvent.Resync, {}]]);
    expect(noRoomEvents).toEqual([]);
  });

  it("stops resyncing a socket once it has left its last signal room or disconnected", async () => {
    const leaver = await joinedClient(USER_A, [DOC_1]);
    const disconnecting = await joinedClient(USER_B, [DOC_1]);

    await emitWithAck(leaver, RealtimeEvent.Leave, { channel: DOC_1 });
    const [serverSide] = await edge.io
      .in(disconnecting.id ?? "")
      .fetchSockets();
    const gone = new Promise((resolve) => {
      edge.io
        .of("/")
        .sockets.get(serverSide?.id ?? "")
        ?.once("disconnect", resolve);
    });
    disconnecting.disconnect();
    await gone;

    expect(resyncAll(edge.io)).toBe(0);
  });
});

describe("startSignalDelivery", () => {
  it("fans notifications out, gates readiness on LISTEN, and resyncs served channels when the listener comes back", async () => {
    const client = await joinedClient(USER_A, [DOC_1]);
    const readiness = createReadiness([Dependency.Listener]);
    const factory = fakeClientFactory();
    listener = startSignalDelivery(
      edge.io,
      readiness,
      factory.openClient,
      () => 0
    );
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));

    const signal = nextEvent<SignalPayload>(client, RealtimeEvent.Signal);
    factory.clients[0]?.notify(envelope({}));
    expect(await signal).toEqual({
      channel: DOC_1,
      type: "comment.created",
      data: {},
    });

    const resync = nextEvent<ResyncPayload>(client, RealtimeEvent.Resync);
    factory.clients[0]?.terminate();
    expect(readiness.isDegraded()).toBe(true);
    expect(await resync).toEqual({});
    expect(readiness.isDegraded()).toBe(false);
    expect(factory.clients).toHaveLength(2);
  });

  it("records each resync it sends, once, with its cause and the sockets it reached", async () => {
    await joinedClient(USER_A, [DOC_1]);
    await joinedClient(USER_B, [PROBE]);
    const readiness = createReadiness([Dependency.Listener]);
    const factory = fakeClientFactory();
    listener = startSignalDelivery(
      edge.io,
      readiness,
      factory.openClient,
      () => 0
    );
    await vi.waitFor(() => expect(readiness.isReady()).toBe(true));
    expect(spansNamed(RealtimeSpan.Resync)).toEqual([]);

    factory.clients[0]?.terminate();
    await vi.waitFor(() => expect(readiness.isDegraded()).toBe(false));

    expect(
      spansNamed(RealtimeSpan.Resync).map((span) => span.attributes)
    ).toEqual([
      {
        [RealtimeSpanAttribute.Cause]: ResyncCause.ListenResumed,
        [RealtimeSpanAttribute.Sockets]: 2,
      },
    ]);
    const samples = vi
      .mocked(log.info)
      .mock.calls.map(([message]) => String(message))
      .filter((message) => message.includes(RealtimeCount.Resyncs))
      .map((message) => JSON.parse(message));
    expect(samples).toEqual([
      expect.objectContaining({
        metric: RealtimeCount.Resyncs,
        value: 2,
        cause: ResyncCause.ListenResumed,
      }),
    ]);
  });
});

describe("startConfiguredSignalDelivery", () => {
  it("logs that the instance will never be ready when no LISTEN connection is configured", () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const readiness = createReadiness([Dependency.Listener]);

    expect(
      startConfiguredSignalDelivery(edge.io, readiness, undefined)
    ).toBeUndefined();

    expect(readiness.isReady()).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: LISTENER_UNCONFIGURED_EVENT })
    );
  });

  it("opens the configured LISTEN connection", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const connect = vi
      .spyOn(pg.Client.prototype, "connect")
      .mockImplementation(() => Promise.reject(new Error("refused")));

    listener = startConfiguredSignalDelivery(
      edge.io,
      createReadiness([Dependency.Listener]),
      {
        auth: ListenerAuth.Password,
        host: "127.0.0.1",
        port: 5432,
        user: "realtime",
        database: "realtime",
        password: "unused",
      }
    );

    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    expect(error).not.toHaveBeenCalled();
  });
});

function delaySamples(): unknown[] {
  return vi
    .mocked(log.info)
    .mock.calls.map(([message]) => String(message))
    .filter((message) =>
      message.includes(RealtimeHistogram.SignalEmitToDeliveryMs)
    )
    .map((message) => JSON.parse(message).value);
}
