import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { log } from "@repo/observability/log";
import pg from "pg";
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
import {
  LISTEN_STATEMENT,
  ListenOnlyViolation,
  listenOnly,
} from "../signal/listen-only-client";
import {
  LISTEN_CONNECTION_ENDED,
  LISTEN_LOST_EVENT,
  LISTEN_STABLE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  reconnectDelayMs,
  type SignalListener,
  startSignalListener,
} from "../signal/listener";
import { RealtimeSpan, RealtimeSpanAttribute } from "../telemetry/spans";
import {
  fakeClientFactory,
  TERMINATED_BY_ADMINISTRATOR,
} from "./fake-listener-client";

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

let listener: SignalListener | undefined;

beforeEach(() => {
  exporter.reset();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await listener?.stop();
  listener = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start(overrides: { random?: () => number } = {}) {
  const factory = fakeClientFactory();
  const onSignal = vi.fn();
  const onListening = vi.fn();
  const onLost = vi.fn();
  listener = startSignalListener({
    openClient: factory.openClient,
    onSignal,
    onListening,
    onLost,
    random: overrides.random ?? (() => 0.5),
  });
  return { ...factory, onSignal, onListening, onLost };
}

describe("the LISTEN-only connection", () => {
  it("issues LISTEN realtime_signal and refuses every other statement", async () => {
    const client = new pg.Client();
    const query = vi
      .spyOn(client, "query")
      .mockResolvedValue(undefined as never);
    const wrapped = listenOnly(client);

    expect(() =>
      Reflect.apply(Reflect.get(wrapped, "query"), wrapped, ["SELECT 1"])
    ).toThrow(ListenOnlyViolation);
    expect(() =>
      Reflect.apply(Reflect.get(wrapped, "query"), wrapped, [
        LISTEN_STATEMENT,
        [],
      ])
    ).toThrow(ListenOnlyViolation);
    expect(query).not.toHaveBeenCalled();

    await wrapped.query(LISTEN_STATEMENT);
    expect(query).toHaveBeenCalledWith(LISTEN_STATEMENT);
  });

  it("throws on any client member outside the listener's surface", () => {
    const wrapped = listenOnly(new pg.Client());

    expect(() => Reflect.get(wrapped, "escapeLiteral")).toThrow(
      ListenOnlyViolation
    );
    expect(() => Reflect.get(wrapped, "copyFrom")).toThrow(ListenOnlyViolation);
    expect(() => Reflect.set(wrapped, "password", "x")).toThrow(
      ListenOnlyViolation
    );
    expect(typeof wrapped.on).toBe("function");
  });

  it("reads symbol keys straight from the client instead of refusing them", () => {
    const client = new pg.Client();
    const marker = Symbol("marker");
    Object.defineProperty(client, marker, { value: "from-client" });
    const wrapped = listenOnly(client);

    expect(Reflect.get(wrapped, marker)).toBe("from-client");
    expect(Reflect.get(wrapped, Symbol.iterator)).toBeUndefined();
  });

  it("is not a thenable, so awaiting it yields the wrapper itself", async () => {
    const wrapped = listenOnly(new pg.Client());

    expect(Reflect.get(wrapped, "then")).toBeUndefined();
    expect(await Promise.resolve(wrapped)).toBe(wrapped);
  });

  it("binds surface methods to the client and passes non-function values through unbound", () => {
    const client = new pg.Client();
    const connect = vi
      .spyOn(client, "connect")
      .mockResolvedValue(undefined as never);
    Object.defineProperty(client, "end", { value: 42 });
    const wrapped = listenOnly(client);

    const detached = Reflect.get(wrapped, "connect");
    Reflect.apply(detached, undefined, []);
    expect(connect.mock.contexts[0]).toBe(client);
    expect(Reflect.get(wrapped, "end")).toBe(42);
  });
});

describe("startSignalListener", () => {
  it("runs only LISTEN realtime_signal, then reports listening and passes its notifications on", async () => {
    const { clients, onListening, onSignal } = start();
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledWith(false));

    const [client] = clients;
    expect(client?.statements).toEqual([LISTEN_STATEMENT]);
    client?.notify("payload-1");
    client?.notify("elsewhere", "another_channel");
    expect(onSignal.mock.calls).toEqual([["payload-1"]]);
  });

  it("reports a lost listener, reconnects after a jittered backoff, LISTENs again and reports it resumed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { clients, onListening, onLost } = start({ random: () => 0.5 });
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));

    clients[0]?.terminate();

    expect(onLost).toHaveBeenCalledWith(TERMINATED_BY_ADMINISTRATOR);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: LISTEN_LOST_EVENT,
        cause: TERMINATED_BY_ADMINISTRATOR,
      })
    );
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0, () => 0.5) - 1);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledWith(true));

    expect(clients).toHaveLength(2);
    expect(clients[1]?.statements).toEqual([LISTEN_STATEMENT]);
    expect(clients[0]?.end).toHaveBeenCalled();
    const [reconnect] = exporter
      .getFinishedSpans()
      .filter((span) => span.name === RealtimeSpan.ListenReconnect);
    expect(reconnect?.attributes).toEqual({
      [RealtimeSpanAttribute.Cause]: TERMINATED_BY_ADMINISTRATOR,
      [RealtimeSpanAttribute.Attempts]: 1,
    });
  });

  it("treats an end with no error as a loss too", async () => {
    const { clients, onListening, onLost } = start();
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));

    clients[0]?.emit("end");

    expect(onLost).toHaveBeenCalledWith(LISTEN_CONNECTION_ENDED);
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledWith(true));
  });

  it("retries a failed connect with growing backoff, and never reports a loss before first listening", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const factory = fakeClientFactory();
    factory.failNext(new Error("refused"));
    factory.failNext(new Error("refused"));
    const onListening = vi.fn();
    const onLost = vi.fn();
    listener = startSignalListener({
      openClient: factory.openClient,
      onSignal: vi.fn(),
      onListening,
      onLost,
      random: () => 0.999,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(factory.clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0, () => 0.999));
    expect(factory.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1, () => 0.999) - 1);
    expect(factory.clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => expect(onListening).toHaveBeenCalledWith(false));
    expect(onLost).not.toHaveBeenCalled();
  });

  it("keeps backing off a listener that drops right after LISTEN, and restarts the backoff once one has held", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const almostOne = () => 0.999;
    const { clients, onListening } = start({ random: almostOne });
    await vi.waitFor(() => expect(onListening).toHaveBeenCalledTimes(1));

    const reconnectsAfter = async (delayMs: number) => {
      const opened = clients.length;
      clients.at(-1)?.terminate();
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(clients).toHaveLength(opened);
      await vi.advanceTimersByTimeAsync(1);
      expect(clients).toHaveLength(opened + 1);
      await vi.waitFor(() =>
        expect(onListening).toHaveBeenCalledTimes(opened + 1)
      );
    };

    await reconnectsAfter(reconnectDelayMs(0, almostOne));
    await reconnectsAfter(reconnectDelayMs(1, almostOne));
    await reconnectsAfter(reconnectDelayMs(2, almostOne));

    await vi.advanceTimersByTimeAsync(LISTEN_STABLE_MS);
    await reconnectsAfter(reconnectDelayMs(0, almostOne));
  });

  it("bounds the backoff at 250 ms base and 10 s cap", () => {
    const almostOne = () => 0.999_999;
    expect(reconnectDelayMs(0, almostOne)).toBe(RECONNECT_BASE_MS - 1);
    expect(reconnectDelayMs(1, almostOne)).toBe(2 * RECONNECT_BASE_MS - 1);
    expect(reconnectDelayMs(6, almostOne)).toBe(RECONNECT_CAP_MS - 1);
    expect(reconnectDelayMs(1000, almostOne)).toBe(RECONNECT_CAP_MS - 1);
    expect(reconnectDelayMs(3, () => 0)).toBe(0);
    expect(RECONNECT_BASE_MS).toBe(250);
    expect(RECONNECT_CAP_MS).toBe(10_000);
  });
});
