import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
  type KeylessTelemetryExportAck,
  KeylessTelemetryRejectionReason,
  type KeylessTelemetrySessionAck,
  KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateRelayTelemetryTransportOptions,
  createRelayTelemetryTransport,
  type TelemetrySessionContext,
  type TelemetrySocketLike,
} from "../src/main/telemetry/relay-telemetry-transport.js";
import { asRecord } from "../src/main/util/api-response-utils.js";

const RELAY_ORIGIN = "https://relay.example.com";
const START_MS = 10_000;
const CONTEXT: TelemetrySessionContext = { appInstallationId: "install-1" };
const DEFER = "defer";

function acceptedHandshake(
  overrides: Partial<{ ttlMs: number; maxBodyBytes: number }> = {}
): KeylessTelemetrySessionAck {
  return {
    accepted: true,
    sessionId: "sess-1",
    exportEvent: KEYLESS_TELEMETRY_EXPORT_EVENT,
    acceptedSignals: [KeylessTelemetrySignal.Metrics],
    maxBodyBytes: KEYLESS_TELEMETRY_MAX_BODY_BYTES,
    ttlMs: 300_000,
    ...overrides,
  };
}

const ACCEPTED_EXPORT: KeylessTelemetryExportAck = { accepted: true };
const INVALID_SESSION: KeylessTelemetryExportAck = {
  accepted: false,
  reason: KeylessTelemetryRejectionReason.InvalidSession,
};

type Ack<T> = T | typeof DEFER;

/** Socket fake whose handshake/export acks are scripted per call. */
class ScriptedSocket implements TelemetrySocketLike {
  connected = false;
  handshakeAcks: Ack<KeylessTelemetrySessionAck>[] = [];
  exportAcks: Ack<KeylessTelemetryExportAck>[] = [];
  disconnects = 0;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly held: Array<(response: unknown) => void> = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    const [payload, ack] = args;
    if (!isAck(ack)) {
      throw new Error("transport emitted without an ack callback");
    }
    this.emitted.push({ event, payload });
    const next =
      event === KEYLESS_TELEMETRY_HANDSHAKE_EVENT
        ? (this.handshakeAcks.shift() ?? acceptedHandshake())
        : (this.exportAcks.shift() ?? ACCEPTED_EXPORT);
    if (next === DEFER) {
      this.held.push(ack);
    } else {
      ack(next);
    }
    return this;
  }

  releaseHeld(response: unknown): void {
    this.held.shift()?.(response);
  }

  disconnect(): this {
    this.disconnects += 1;
    this.connected = false;
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  connect(): void {
    this.connected = true;
    for (const listener of this.listeners.get("connect") ?? []) {
      listener();
    }
  }

  count(event: string): number {
    return this.emitted.filter((entry) => entry.event === event).length;
  }
}

function makeTransport(
  sockets: ScriptedSocket[] = [new ScriptedSocket()],
  overrides: Partial<CreateRelayTelemetryTransportOptions> = {}
) {
  const clock = { now: START_MS };
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const debug: string[] = [];
  const warn: string[] = [];
  const connectFn = vi.fn((_url: string): TelemetrySocketLike => {
    const socket = sockets.shift();
    if (!socket) {
      throw new Error("no scripted socket left");
    }
    return socket;
  });
  const transport = createRelayTelemetryTransport({
    getRelayOrigin: () => RELAY_ORIGIN,
    connectFn,
    now: () => clock.now,
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    // Deliberately does not cancel, so a test can fire an already-settled timer.
    clearTimeoutFn: (handle) => {
      cleared.push(handle);
    },
    log: {
      warn: (message) => warn.push(message),
      debug: (message) => debug.push(message),
    },
    ...overrides,
  });
  return { transport, clock, timers, cleared, debug, warn, connectFn };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function body(size: number): Uint8Array {
  return new Uint8Array(size).fill(1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relay telemetry transport before and around the handshake", () => {
  it("declines an export before start() without connecting or counting a drop", async () => {
    const { transport, connectFn } = makeTransport();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(connectFn).not.toHaveBeenCalled();
    expect(transport.getDiagnostics()).toEqual({
      connected: false,
      hasSession: false,
      inCooldown: false,
      warmUpQueueDepth: 0,
      sent: 0,
      droppedOversize: 0,
      droppedNoSession: 0,
      droppedRateLimited: 0,
      droppedCollectorUnavailable: 0,
      droppedInvalid: 0,
    });
  });

  it("sends only the installation id when the context has no version or environment", async () => {
    const socket = new ScriptedSocket();
    const { transport, connectFn } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    await tick();
    expect(connectFn).toHaveBeenCalledWith(`${RELAY_ORIGIN}/telemetry`);
    expect(socket.emitted[0]).toStrictEqual({
      event: KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
      payload: { appInstallationId: "install-1" },
    });
  });

  it("sends the version and environment when the context carries them", async () => {
    const socket = new ScriptedSocket();
    const { transport } = makeTransport([socket]);
    transport.start({
      appInstallationId: "install-1",
      serviceVersion: "9.9.9",
      deploymentEnvironmentName: "staging",
    });
    socket.connect();
    await tick();
    expect(socket.emitted[0]?.payload).toStrictEqual({
      appInstallationId: "install-1",
      serviceVersion: "9.9.9",
      deploymentEnvironmentName: "staging",
    });
  });

  it("joins an in-flight handshake instead of starting another", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [DEFER];
    const { transport } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    const first = transport.export(KeylessTelemetrySignal.Metrics, body(4));
    const second = transport.export(KeylessTelemetrySignal.Logs, body(4));
    await tick();
    expect(socket.count(KEYLESS_TELEMETRY_HANDSHAKE_EVENT)).toBe(1);
    socket.releaseHeld(acceptedHandshake());
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(socket.count(KEYLESS_TELEMETRY_HANDSHAKE_EVENT)).toBe(1);
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(2);
  });

  it("discards a handshake ack that lands after the socket was replaced", async () => {
    const stale = new ScriptedSocket();
    stale.handshakeAcks = [DEFER];
    const fresh = new ScriptedSocket();
    const { transport } = makeTransport([stale, fresh]);
    transport.start(CONTEXT);
    stale.connect();
    transport.start(CONTEXT);
    expect(stale.disconnects).toBe(1);
    stale.releaseHeld(acceptedHandshake());
    await tick();
    expect(transport.getDiagnostics().hasSession).toBe(false);
    fresh.connect();
    await tick();
    expect(transport.getDiagnostics().hasSession).toBe(true);
  });

  it("stays sessionless without logging a rejection when the handshake ack times out", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [DEFER];
    const { transport, timers, debug } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    const pending = transport.export(KeylessTelemetrySignal.Metrics, body(4));
    timers[0]?.();
    expect(await pending).toBe(false);
    expect(transport.getDiagnostics()).toMatchObject({
      hasSession: false,
      droppedNoSession: 1,
      warmUpQueueDepth: 1,
    });
    expect(debug).toEqual([]);
  });

  it("falls back to the default TTL and body cap when the ack carries unusable values", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [
      acceptedHandshake({ ttlMs: Number.NaN, maxBodyBytes: 0 }),
    ];
    const { transport, clock } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(
        KeylessTelemetrySignal.Metrics,
        body(KEYLESS_TELEMETRY_MAX_BODY_BYTES)
      )
    ).toBe(true);
    // Default TTL 300s less the 30s renew margin.
    clock.now = START_MS + 270_000 - 1;
    await transport.export(KeylessTelemetrySignal.Metrics, body(4));
    expect(socket.count(KEYLESS_TELEMETRY_HANDSHAKE_EVENT)).toBe(1);
    clock.now = START_MS + 270_000;
    await transport.export(KeylessTelemetrySignal.Metrics, body(4));
    expect(socket.count(KEYLESS_TELEMETRY_HANDSHAKE_EVENT)).toBe(2);
  });

  it("logs 'unknown error' when the relay origin throws a non-Error", () => {
    const { transport, warn, connectFn } = makeTransport([], {
      getRelayOrigin: () => throwValue("not an error"),
    });
    transport.start(CONTEXT);
    expect(warn).toEqual([
      "keyless telemetry disabled: invalid relay origin (unknown error)",
    ]);
    expect(connectFn).not.toHaveBeenCalled();
  });
});

describe("relay telemetry transport send paths", () => {
  it("parks an export when the socket dropped without a disconnect event", async () => {
    const socket = new ScriptedSocket();
    const { transport } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    await tick();
    socket.connected = false;
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(transport.getDiagnostics()).toMatchObject({
      hasSession: true,
      warmUpQueueDepth: 1,
      droppedNoSession: 1,
    });
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(0);
  });

  it("drops a warm-up body larger than the negotiated session cap", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [acceptedHandshake({ maxBodyBytes: 50 })];
    const { transport } = makeTransport([socket]);
    transport.start(CONTEXT);
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(100))
    ).toBe(false);
    socket.connect();
    await tick();
    expect(transport.getDiagnostics()).toMatchObject({
      droppedOversize: 1,
      droppedNoSession: 1,
      warmUpQueueDepth: 0,
      sent: 0,
    });
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(0);
  });

  it("counts a second invalid_session after the single retry as no-session", async () => {
    const socket = new ScriptedSocket();
    socket.exportAcks = [INVALID_SESSION, INVALID_SESSION];
    const { transport } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(socket.count(KEYLESS_TELEMETRY_HANDSHAKE_EVENT)).toBe(2);
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(2);
    expect(transport.getDiagnostics()).toMatchObject({
      droppedNoSession: 1,
      hasSession: false,
      sent: 0,
    });
  });

  it("counts invalid_session as no-session when the re-handshake is refused", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [
      acceptedHandshake(),
      { accepted: false, reason: KeylessTelemetryRejectionReason.AtCapacity },
    ];
    socket.exportAcks = [INVALID_SESSION];
    const { transport, debug } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(1);
    expect(transport.getDiagnostics()).toMatchObject({
      droppedNoSession: 1,
      hasSession: false,
    });
    expect(debug).toEqual([
      `keyless telemetry handshake rejected: ${KeylessTelemetryRejectionReason.AtCapacity}`,
    ]);
  });

  it.each([
    {
      name: "rate_limited without a hint cools down for the default",
      ack: {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.RateLimited,
      },
      seconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
      counter: "droppedRateLimited",
    },
    {
      name: "rate_limited honours its hint",
      ack: {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.RateLimited,
        retryAfterSeconds: 7,
      },
      seconds: 7,
      counter: "droppedRateLimited",
    },
    {
      name: "rate_limited with a zero hint cools down for the default",
      ack: {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.RateLimited,
        retryAfterSeconds: 0,
      },
      seconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
      counter: "droppedRateLimited",
    },
    {
      name: "collector_unavailable honours its hint",
      ack: {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.CollectorUnavailable,
        retryAfterSeconds: 7,
      },
      seconds: 7,
      counter: "droppedCollectorUnavailable",
    },
    {
      name: "request_timeout without a hint cools down for the default",
      ack: {
        accepted: false,
        reason: KeylessTelemetryRejectionReason.RequestTimeout,
      },
      seconds: KEYLESS_TELEMETRY_RETRY_AFTER_SECONDS,
      counter: "droppedCollectorUnavailable",
    },
  ] as const)("$name", async ({ ack, seconds, counter }) => {
    const socket = new ScriptedSocket();
    socket.exportAcks = [ack];
    const { transport, clock } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(transport.getDiagnostics()[counter]).toBe(1);
    clock.now = START_MS + seconds * 1000 - 1;
    expect(transport.getDiagnostics().inCooldown).toBe(true);
    clock.now = START_MS + seconds * 1000;
    expect(transport.getDiagnostics().inCooldown).toBe(false);
  });

  it("drops a content-side rejection as invalid without a cooldown and logs the reason", async () => {
    const socket = new ScriptedSocket();
    socket.exportAcks = [
      { accepted: false, reason: KeylessTelemetryRejectionReason.OtlpRejected },
    ];
    const { transport, debug } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(transport.getDiagnostics()).toMatchObject({
      droppedInvalid: 1,
      inCooldown: false,
    });
    expect(debug).toEqual([
      `keyless telemetry export rejected: ${KeylessTelemetryRejectionReason.OtlpRejected}`,
    ]);
  });

  it("ignores an export ack that arrives after its timeout, and a late timer after an ack", async () => {
    const socket = new ScriptedSocket();
    socket.exportAcks = [DEFER];
    const { transport, timers, cleared } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    await tick();
    const handshakeTimer = timers.length - 1;
    expect(cleared).toEqual([handshakeTimer]);
    const pending = transport.export(KeylessTelemetrySignal.Metrics, body(4));
    await tick();
    timers.at(-1)?.();
    expect(await pending).toBe(false);
    socket.releaseHeld(ACCEPTED_EXPORT);
    await tick();
    timers[handshakeTimer]?.();
    await tick();
    // The late ack neither cancels the already-fired export timer nor counts.
    expect(cleared).toEqual([handshakeTimer]);
    expect(transport.getDiagnostics()).toMatchObject({
      sent: 0,
      droppedCollectorUnavailable: 1,
      hasSession: true,
    });
  });

  it("keeps only the newest exports when the warm-up queue is full", async () => {
    const socket = new ScriptedSocket();
    const { transport } = makeTransport([socket], { warmUpQueueLimit: 2 });
    transport.start(CONTEXT);
    for (const size of [1, 2, 3]) {
      await transport.export(KeylessTelemetrySignal.Metrics, body(size));
    }
    expect(transport.getDiagnostics().warmUpQueueDepth).toBe(2);
    socket.connect();
    await tick();
    expect(
      socket.emitted
        .filter((entry) => entry.event === KEYLESS_TELEMETRY_EXPORT_EVENT)
        .map((entry) => asRecord(entry.payload).body)
    ).toEqual([body(2), body(3)]);
  });

  it("parks an export whose socket was torn down while its session lookup was pending", async () => {
    const socket = new ScriptedSocket();
    let origin = RELAY_ORIGIN;
    const { transport, debug } = makeTransport([socket], {
      getRelayOrigin: () => origin,
    });
    transport.start(CONTEXT);
    socket.connect();
    await tick();
    const pending = transport.export(KeylessTelemetrySignal.Metrics, body(4));
    origin = "not a url";
    transport.start(CONTEXT);
    expect(await pending).toBe(false);
    expect(transport.getDiagnostics()).toMatchObject({
      connected: false,
      droppedNoSession: 1,
      warmUpQueueDepth: 1,
    });
    expect(debug).toEqual([]);
  });

  it("drops a retry that exceeds the cap of the re-negotiated session", async () => {
    const socket = new ScriptedSocket();
    socket.handshakeAcks = [
      acceptedHandshake(),
      acceptedHandshake({ maxBodyBytes: 50 }),
    ];
    socket.exportAcks = [INVALID_SESSION];
    const { transport } = makeTransport([socket]);
    transport.start(CONTEXT);
    socket.connect();
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(100))
    ).toBe(false);
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(1);
    expect(transport.getDiagnostics()).toMatchObject({
      droppedOversize: 1,
      sent: 0,
    });
  });

  it("does not buffer anything when the warm-up limit is zero", async () => {
    const socket = new ScriptedSocket();
    const { transport } = makeTransport([socket], { warmUpQueueLimit: 0 });
    transport.start(CONTEXT);
    expect(
      await transport.export(KeylessTelemetrySignal.Metrics, body(4))
    ).toBe(false);
    expect(transport.getDiagnostics()).toMatchObject({
      warmUpQueueDepth: 0,
      droppedNoSession: 1,
    });
    socket.connect();
    await tick();
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(0);
  });
});

describe("relay telemetry transport shutdown drain", () => {
  it("stop() bounds its drain with the global timer when none is injected", async () => {
    vi.useFakeTimers();
    const socket = new ScriptedSocket();
    socket.exportAcks = [DEFER];
    const transport = createRelayTelemetryTransport({
      getRelayOrigin: () => RELAY_ORIGIN,
      connectFn: (): TelemetrySocketLike => socket,
      shutdownDrainMs: 200,
      ackTimeoutMs: 1000,
      log: { warn: () => undefined, debug: () => undefined },
    });
    transport.start(CONTEXT);
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    const pending = transport.export(KeylessTelemetrySignal.Metrics, body(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.count(KEYLESS_TELEMETRY_EXPORT_EVENT)).toBe(1);
    let stopped = false;
    const stopping = Promise.resolve(transport.stop()).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(stopped).toBe(false);
    expect(socket.disconnects).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(socket.disconnects).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(false);
  });
});

function throwValue(value: unknown): never {
  throw value;
}

function isAck(value: unknown): value is (response: unknown) => void {
  return typeof value === "function";
}
