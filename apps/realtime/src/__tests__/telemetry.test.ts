import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { log } from "@repo/observability/log";
import {
  resetSpanFlushHook,
  setSpanFlushHook,
} from "@repo/observability/tracing/hooks";
import { initTracing } from "@repo/observability/tracing/provider";
import { RealtimeErrorCode } from "@repo/realtime-contract/error-codes";
import { GrantAccess } from "@repo/realtime-contract/grants";
import { RealtimeEvent } from "@repo/realtime-contract/protocol";
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
import { InternalAuth } from "../http/internal";
import { RealtimeGauge, startGaugeReporter } from "../telemetry/gauges";
import {
  MAX_CLIENT_VERSION_LENGTH,
  RealtimeSpan,
  RealtimeSpanAttribute,
  recordInternalRequest,
} from "../telemetry/spans";
import {
  flushTelemetry,
  initRealtimeTracing,
  SPAN_FLUSH_DEADLINE_MS,
} from "../telemetry/tracing";
import {
  connectError,
  type EdgeHarness,
  emitWithAck,
  grantedTokenFor,
  nextEvent,
  ORG_A,
  OTHER_SIGNER,
  openClient,
  startEdge,
  tokenFor,
  USER_A,
  validAuth,
  welcomedClient,
} from "./edge-harness";

vi.mock("@repo/observability/tracing/provider", async () => {
  const config = await import("@repo/observability/tracing/config");
  return {
    initTracing: vi.fn(() => ({
      enabled: false,
      reason: config.TracingDisabledReason.NotDeployed,
    })),
  };
});

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function spansNamed(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

describe("spans", () => {
  let edge: EdgeHarness;
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    exporter.reset();
    edge = await startEdge();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await edge.close();
  });

  it("records a join and a join rejection with the kind read from the address", async () => {
    const token = await grantedTokenFor(ORG_A, USER_A, [
      { pattern: `comments:${ORG_A}:*`, access: GrantAccess.Read },
    ]);
    const { client } = await welcomedClient(edge.url, token, clients);

    await emitWithAck(client, RealtimeEvent.Join, {
      channel: `comments:${ORG_A}:doc-1`,
    });
    await emitWithAck(client, RealtimeEvent.Join, {
      channel: `probe:${ORG_A}:x`,
    });
    await emitWithAck(client, RealtimeEvent.Join, { channel: "malformed" });

    const [joined] = spansNamed(RealtimeSpan.Join);
    expect(joined?.attributes).toEqual({
      [RealtimeSpanAttribute.ConnectionId]: client.id,
      [RealtimeSpanAttribute.OrgId]: ORG_A,
      [RealtimeSpanAttribute.UserId]: USER_A,
      [RealtimeSpanAttribute.ChannelKind]: "comments",
    });
    const rejected = spansNamed(RealtimeSpan.JoinRejected);
    expect(rejected.map((span) => span.attributes)).toEqual([
      expect.objectContaining({
        [RealtimeSpanAttribute.ChannelKind]: "probe",
        [RealtimeSpanAttribute.Code]: RealtimeErrorCode.Forbidden,
      }),
      expect.not.objectContaining({
        [RealtimeSpanAttribute.ChannelKind]: expect.anything(),
      }),
    ]);
    expect(rejected[1]?.attributes[RealtimeSpanAttribute.Code]).toBe(
      RealtimeErrorCode.BadScope
    );
  });

  it("records a point span as soon as a connection is admitted", async () => {
    const { client } = await welcomedClient(
      edge.url,
      await tokenFor(ORG_A, USER_A),
      clients
    );

    const [admitted] = spansNamed(RealtimeSpan.ConnectionAdmitted);
    expect(admitted?.attributes).toEqual({
      [RealtimeSpanAttribute.ConnectionId]: client.id,
      [RealtimeSpanAttribute.OrgId]: ORG_A,
      [RealtimeSpanAttribute.UserId]: USER_A,
      [RealtimeSpanAttribute.ClientVersion]: "test/1.0.0",
    });
    expect(spansNamed(RealtimeSpan.Connection)).toEqual([]);
  });

  it("records the connection's lifetime, ending it with the disconnect reason", async () => {
    const token = await tokenFor(ORG_A, USER_A);
    const { client } = await welcomedClient(edge.url, token, clients);
    const connectionId = client.id;
    expect(spansNamed(RealtimeSpan.Connection)).toEqual([]);

    client.disconnect();

    await vi.waitFor(() =>
      expect(spansNamed(RealtimeSpan.Connection)).toHaveLength(1)
    );
    const [connection] = spansNamed(RealtimeSpan.Connection);
    expect(connection?.attributes).toEqual({
      [RealtimeSpanAttribute.ConnectionId]: connectionId,
      [RealtimeSpanAttribute.OrgId]: ORG_A,
      [RealtimeSpanAttribute.UserId]: USER_A,
      [RealtimeSpanAttribute.ClientVersion]: "test/1.0.0",
      [RealtimeSpanAttribute.DisconnectReason]: "client namespace disconnect",
    });
    expect(JSON.stringify(connection?.attributes)).not.toContain(token);
  });

  it("caps the client-chosen client version it records", async () => {
    const token = await tokenFor(ORG_A, USER_A);
    const client = openClient(edge.url, {
      ...validAuth(token),
      clientVersion: "v".repeat(MAX_CLIENT_VERSION_LENGTH + 1),
    });
    clients.push(client);
    await nextEvent(client, RealtimeEvent.Welcome);

    client.disconnect();

    await vi.waitFor(() =>
      expect(spansNamed(RealtimeSpan.Connection)).toHaveLength(1)
    );
    const [connection] = spansNamed(RealtimeSpan.Connection);
    expect(connection?.attributes[RealtimeSpanAttribute.ClientVersion]).toBe(
      "v".repeat(MAX_CLIENT_VERSION_LENGTH)
    );
  });

  it("records a handshake rejection with its code and no token", async () => {
    const token = await tokenFor(ORG_A, USER_A, OTHER_SIGNER);
    const refused = openClient(edge.url, validAuth(token));
    clients.push(refused);

    await connectError(refused);

    const [rejection] = spansNamed(RealtimeSpan.HandshakeRejected);
    expect(rejection?.attributes[RealtimeSpanAttribute.Code]).toBe(
      RealtimeErrorCode.Unauthorized
    );
    expect(JSON.stringify(rejection?.attributes)).not.toContain(token);
  });
});

describe("recordInternalRequest", () => {
  beforeEach(() => {
    exporter.reset();
  });

  it("records how the request authenticated, or why its bearer was rejected (ISS-11966)", () => {
    recordInternalRequest({
      path: "/internal/revoke",
      status: 202,
      auth: InternalAuth.Oidc,
    });
    recordInternalRequest({
      path: "/internal/revoke",
      status: 401,
      oidcRejection: "environment",
    });

    expect(
      spansNamed(RealtimeSpan.InternalRequest).map((span) => span.attributes)
    ).toEqual([
      {
        [RealtimeSpanAttribute.InternalPath]: "/internal/revoke",
        [RealtimeSpanAttribute.HttpStatus]: 202,
        [RealtimeSpanAttribute.InternalAuth]: "oidc",
      },
      {
        [RealtimeSpanAttribute.InternalPath]: "/internal/revoke",
        [RealtimeSpanAttribute.HttpStatus]: 401,
        [RealtimeSpanAttribute.Cause]: "environment",
      },
    ]);
  });
});

describe("startGaugeReporter", () => {
  it("reports live connections and the degraded state now and on every interval, untagged", () => {
    vi.useFakeTimers();
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    let live = 3;

    const stop = startGaugeReporter(
      { liveConnections: () => live, degraded: () => true },
      1000
    );
    live = 4;
    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(5000);

    const metrics = info.mock.calls.map(([message]) =>
      JSON.parse(String(message))
    );
    expect(metrics).toEqual([
      {
        metric: RealtimeGauge.LiveConnections,
        origin: "realtime",
        value: 3,
        _telemetryMetric: true,
      },
      {
        metric: RealtimeGauge.Degraded,
        origin: "realtime",
        value: 1,
        _telemetryMetric: true,
      },
      {
        metric: RealtimeGauge.LiveConnections,
        origin: "realtime",
        value: 4,
        _telemetryMetric: true,
      },
      {
        metric: RealtimeGauge.Degraded,
        origin: "realtime",
        value: 1,
        _telemetryMetric: true,
      },
    ]);
  });
});

describe("initRealtimeTracing", () => {
  it("records every span when no sample rate is configured", () => {
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "");

    initRealtimeTracing();

    expect(process.env.DD_TRACE_SAMPLE_RATE).toBe("1");
    expect(initTracing).toHaveBeenCalled();
  });

  it("keeps a sample rate the deploy set", () => {
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.stubEnv("DD_TRACE_SAMPLE_RATE", "0.5");

    initRealtimeTracing();

    expect(process.env.DD_TRACE_SAMPLE_RATE).toBe("0.5");
  });
});

describe("flushTelemetry", () => {
  afterEach(() => {
    resetSpanFlushHook();
  });

  it("flushes buffered spans as well as logs", async () => {
    const flushLogs = vi.spyOn(log, "flush").mockResolvedValue(undefined);
    const flushSpans = vi.fn(() => Promise.resolve());
    setSpanFlushHook(flushSpans);

    await flushTelemetry();

    expect(flushSpans).toHaveBeenCalledOnce();
    expect(flushLogs).toHaveBeenCalledOnce();
  });

  it("settles at the deadline when a span export never does", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "flush").mockResolvedValue(undefined);
    setSpanFlushHook(() => new Promise<void>(() => undefined));
    let settled = false;

    const flushed = flushTelemetry().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SPAN_FLUSH_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;

    expect(settled).toBe(true);
  });
});
