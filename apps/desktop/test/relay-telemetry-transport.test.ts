import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  type KeylessTelemetryExportAck,
  KeylessTelemetryRejectionReason,
  type KeylessTelemetrySessionAck,
  KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import {
  createRelayTelemetryTransport,
  type TelemetrySessionContext,
  type TelemetrySocketLike,
} from "../src/main/relay-telemetry-transport.js";

const CONTEXT: TelemetrySessionContext = {
  appInstallationId: "install_abc",
  serviceVersion: "1.2.3",
  deploymentEnvironmentName: "production",
};

const ACCEPTED_HANDSHAKE: KeylessTelemetrySessionAck = {
  accepted: true,
  sessionId: "sess-1",
  exportEvent: KEYLESS_TELEMETRY_EXPORT_EVENT,
  acceptedSignals: [
    KeylessTelemetrySignal.Traces,
    KeylessTelemetrySignal.Metrics,
    KeylessTelemetrySignal.Logs,
  ],
  maxBodyBytes: KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  ttlMs: 300_000,
};

const ACCEPTED_EXPORT: KeylessTelemetryExportAck = { accepted: true };

type EmittedEvent = { event: string; payload: unknown };

/** Deterministic fake of the Socket.IO client socket the transport drives. */
class FakeTelemetrySocket implements TelemetrySocketLike {
  connected = false;
  handshakeAck: KeylessTelemetrySessionAck | null = ACCEPTED_HANDSHAKE;
  exportAckQueue: KeylessTelemetryExportAck[] = [];
  exportAck: KeylessTelemetryExportAck | null = ACCEPTED_EXPORT;
  emitThrows = false;
  /** When true, export acks are held until resolvePendingExports() is called. */
  deferExportAck = false;
  readonly emitted: EmittedEvent[] = [];
  handshakeCount = 0;
  exportCount = 0;
  disconnectCount = 0;
  private readonly pendingExportAcks: Array<(response: unknown) => void> = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    if (this.emitThrows) {
      throw new Error("emit boom");
    }
    const payload = args[0];
    const ack = args[1];
    this.emitted.push({ event, payload });
    if (event === KEYLESS_TELEMETRY_HANDSHAKE_EVENT) {
      this.handshakeCount += 1;
      if (this.handshakeAck && typeof ack === "function") {
        (ack as (r: unknown) => void)(this.handshakeAck);
      }
      return this;
    }
    if (event === KEYLESS_TELEMETRY_EXPORT_EVENT) {
      this.exportCount += 1;
      if (this.deferExportAck && typeof ack === "function") {
        this.pendingExportAcks.push(ack as (r: unknown) => void);
        return this;
      }
      const next = this.exportAckQueue.shift() ?? this.exportAck;
      if (next && typeof ack === "function") {
        (ack as (r: unknown) => void)(next);
      }
    }
    return this;
  }

  resolvePendingExports(response: KeylessTelemetryExportAck): void {
    const acks = this.pendingExportAcks.splice(
      0,
      this.pendingExportAcks.length
    );
    for (const ack of acks) {
      ack(response);
    }
  }

  disconnect(): this {
    this.disconnectCount += 1;
    this.connected = false;
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  triggerConnect(): void {
    this.connected = true;
    for (const listener of this.listeners.get("connect") ?? []) {
      listener();
    }
  }

  triggerDisconnect(): void {
    this.connected = false;
    for (const listener of this.listeners.get("disconnect") ?? []) {
      listener();
    }
  }

  exportPayloads(): Record<string, unknown>[] {
    return this.emitted
      .filter((e) => e.event === KEYLESS_TELEMETRY_EXPORT_EVENT)
      .map((e) => e.payload as Record<string, unknown>);
  }
}

type Harness = {
  transport: ReturnType<typeof createRelayTelemetryTransport>;
  socket: FakeTelemetrySocket;
  timers: Array<() => void>;
  clock: { now: number };
};

function makeHarness(socket = new FakeTelemetrySocket()): Harness {
  const timers: Array<() => void> = [];
  const clock = { now: 10_000 };
  const transport = createRelayTelemetryTransport({
    getRelayOrigin: () => "https://relay.example.com",
    connectFn: () => socket,
    now: () => clock.now,
    setTimeoutFn: (cb) => {
      timers.push(cb);
      return timers.length - 1;
    },
    clearTimeoutFn: (handle) => {
      if (typeof handle === "number" && timers[handle]) {
        timers[handle] = () => undefined;
      }
    },
    log: { warn: () => undefined, debug: () => undefined },
  });
  return { transport, socket, timers, clock };
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function body(size: number): Uint8Array {
  return new Uint8Array(size).fill(7);
}

test("handshakes on connect and ships an export with a valid envelope", async () => {
  const { transport, socket } = makeHarness();
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  const ok = await transport.export(KeylessTelemetrySignal.Traces, body(64));
  assert.equal(ok, true);
  assert.equal(socket.handshakeCount, 1);
  const [envelope] = socket.exportPayloads();
  assert.equal(envelope.sessionId, "sess-1");
  assert.equal(envelope.signal, KeylessTelemetrySignal.Traces);
  assert.equal(envelope.contentType, "application/x-protobuf");
  assert.ok(envelope.body instanceof Uint8Array);

  transport.stop();
});

test("sends the self-asserted identity in the handshake", async () => {
  const { transport, socket } = makeHarness();
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  const handshake = socket.emitted.find(
    (e) => e.event === KEYLESS_TELEMETRY_HANDSHAKE_EVENT
  );
  assert.deepEqual(handshake?.payload, {
    appInstallationId: "install_abc",
    serviceVersion: "1.2.3",
    deploymentEnvironmentName: "production",
  });
  transport.stop();
});

test("buffers exports issued before the session is ready and flushes on connect", async () => {
  const { transport, socket } = makeHarness();
  transport.start(CONTEXT);

  // Not connected yet -> warm-up queue, reported as dropped-for-now.
  const early = await transport.export(KeylessTelemetrySignal.Logs, body(16));
  assert.equal(early, false);

  socket.triggerConnect();
  await tick();
  await tick();

  const payloads = socket.exportPayloads();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.signal, KeylessTelemetrySignal.Logs);
  transport.stop();
});

test("drops oversize bodies without emitting", async () => {
  const { transport, socket } = makeHarness();
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  const ok = await transport.export(
    KeylessTelemetrySignal.Traces,
    body(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1)
  );
  assert.equal(ok, false);
  assert.equal(socket.exportCount, 0);
  transport.stop();
});

test("re-handshakes once and retries on invalid_session", async () => {
  const socket = new FakeTelemetrySocket();
  socket.exportAckQueue = [
    { accepted: false, reason: KeylessTelemetryRejectionReason.InvalidSession },
    ACCEPTED_EXPORT,
  ];
  const { transport } = makeHarness(socket);
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  const ok = await transport.export(KeylessTelemetrySignal.Traces, body(8));
  assert.equal(ok, true);
  assert.equal(socket.exportCount, 2);
  // First handshake on connect, second on the invalid_session recovery.
  assert.equal(socket.handshakeCount, 2);
  transport.stop();
});

test("enters cooldown on rate_limited and drops further exports until it elapses", async () => {
  const socket = new FakeTelemetrySocket();
  socket.exportAck = {
    accepted: false,
    reason: KeylessTelemetryRejectionReason.RateLimited,
    retryAfterSeconds: 30,
  };
  const harness = makeHarness(socket);
  harness.transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  const first = await harness.transport.export(
    KeylessTelemetrySignal.Traces,
    body(8)
  );
  assert.equal(first, false);
  assert.equal(socket.exportCount, 1);

  // Within cooldown: dropped without touching the socket.
  const second = await harness.transport.export(
    KeylessTelemetrySignal.Traces,
    body(8)
  );
  assert.equal(second, false);
  assert.equal(socket.exportCount, 1);

  // After cooldown elapses, exports resume.
  socket.exportAck = ACCEPTED_EXPORT;
  harness.clock.now += 31_000;
  const third = await harness.transport.export(
    KeylessTelemetrySignal.Traces,
    body(8)
  );
  assert.equal(third, true);
  assert.equal(socket.exportCount, 2);
  harness.transport.stop();
});

test("re-handshakes after the session TTL renewal window elapses", async () => {
  const { transport, socket, clock } = makeHarness();
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  assert.equal(
    await transport.export(KeylessTelemetrySignal.Traces, body(8)),
    true
  );
  assert.equal(socket.handshakeCount, 1);

  // Advance past ttl(300s) - renewMargin(30s) = 270s.
  clock.now += 271_000;
  assert.equal(
    await transport.export(KeylessTelemetrySignal.Traces, body(8)),
    true
  );
  assert.equal(socket.handshakeCount, 2);
  transport.stop();
});

test("treats a missing ack as a transient collector stall", async () => {
  const socket = new FakeTelemetrySocket();
  const { transport, timers } = makeHarness(socket);
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  // Make export acks never arrive. Let export() reach emitWithAck and register
  // its ack timer, then fire that timer to simulate the bound elapsing.
  socket.exportAck = null;
  const pending = transport.export(KeylessTelemetrySignal.Traces, body(8));
  await tick();
  timers.at(-1)?.();
  assert.equal(await pending, false);
  transport.stop();
});

test("never throws when the socket emit fails", async () => {
  const socket = new FakeTelemetrySocket();
  const { transport } = makeHarness(socket);
  transport.start(CONTEXT);
  socket.connected = true;
  socket.emitThrows = true;

  const ok = await transport.export(KeylessTelemetrySignal.Traces, body(8));
  assert.equal(ok, false);
  transport.stop();
});

test("reports send and drop accounting via diagnostics", async () => {
  const { transport, socket } = makeHarness();
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  assert.equal(
    await transport.export(KeylessTelemetrySignal.Traces, body(8)),
    true
  );
  assert.equal(
    await transport.export(
      KeylessTelemetrySignal.Traces,
      body(KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1)
    ),
    false
  );

  const diagnostics = transport.getDiagnostics();
  assert.equal(diagnostics.sent, 1);
  assert.equal(diagnostics.droppedOversize, 1);
  assert.equal(diagnostics.connected, true);
  assert.equal(diagnostics.hasSession, true);
  transport.stop();
});

test("stop() drains an in-flight export before disconnecting", async () => {
  const socket = new FakeTelemetrySocket();
  const { transport } = makeHarness(socket);
  transport.start(CONTEXT);
  socket.triggerConnect();
  await tick();

  // Start an export whose ack is held — it stays in flight.
  socket.deferExportAck = true;
  const exportPromise = transport.export(KeylessTelemetrySignal.Logs, body(8));
  await tick();
  assert.equal(socket.exportCount, 1);

  // stop() must wait on the in-flight export, not disconnect immediately.
  let stopResolved = false;
  const stopPromise = transport.stop().then(() => {
    stopResolved = true;
  });
  await tick();
  assert.equal(stopResolved, false);
  assert.equal(socket.disconnectCount, 0);

  // Deliver the ack → the send completes → the drain finishes → stop tears down.
  socket.resolvePendingExports(ACCEPTED_EXPORT);
  assert.equal(await exportPromise, true);
  await stopPromise;
  assert.equal(stopResolved, true);
  assert.equal(socket.disconnectCount, 1);
});

test("disabled origin keeps the transport inert", async () => {
  const socket = new FakeTelemetrySocket();
  const timers: Array<() => void> = [];
  const transport = createRelayTelemetryTransport({
    getRelayOrigin: () => "not-a-valid-origin",
    connectFn: () => socket,
    now: () => 0,
    setTimeoutFn: (cb) => {
      timers.push(cb);
      return 0;
    },
    clearTimeoutFn: () => undefined,
    log: { warn: () => undefined, debug: () => undefined },
  });
  transport.start(CONTEXT);
  const ok = await transport.export(KeylessTelemetrySignal.Traces, body(8));
  assert.equal(ok, false);
  assert.equal(socket.handshakeCount, 0);
  transport.stop();
});
