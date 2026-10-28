/**
 * ISS-11866 (R4): the lifecycle heartbeat must carry the keyless relay
 * transport's drop counters and its sent counter, so Datadog can read what the
 * lane lost as a rate.
 *
 * Driven with the REAL transport rather than a hand-built counter object, so a
 * mapping that reads the wrong diagnostics field fails here instead of shipping
 * one cause's count under another cause's name.
 */
import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  KEYLESS_TELEMETRY_EXPORT_EVENT,
  KEYLESS_TELEMETRY_HANDSHAKE_EVENT,
  KEYLESS_TELEMETRY_MAX_BODY_BYTES,
  type KeylessTelemetryExportAck,
  KeylessTelemetryRejectionReason,
  KeylessTelemetrySignal,
} from "@repo/shared-platform/keyless-telemetry";
import { afterEach, test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppOperatingMode,
  type DesktopTelemetryExportCounts,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import {
  createRelayTelemetryTransport,
  type TelemetrySocketLike,
} from "../src/main/telemetry/relay-telemetry-transport.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectAppLifecycleRecords,
  createTrackedRuntimeFactory,
  manualHeartbeat,
} from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(resetTrackedRuntime);

const EXPORT_COUNT_ATTRIBUTES = [
  TelemetryAttribute.AppTelemetryExportSentCount,
  TelemetryAttribute.AppTelemetryExportDroppedOversizeCount,
  TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount,
  TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount,
  TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount,
  TelemetryAttribute.AppTelemetryExportDroppedInvalidCount,
];

test("each heartbeat reports the transport's sent and per-cause drop counts, read at that tick", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const heartbeat = manualHeartbeat();
  const relay = scriptedRelay();
  const transport = createRelayTelemetryTransport({
    getRelayOrigin: () => "https://relay.example.test",
    connectFn: () => relay.socket,
    now: () => relay.clock.now,
    warmUpQueueLimit: 0,
    log: { warn: () => undefined, debug: () => undefined },
  });
  transport.start({ appInstallationId: "install-1" });
  relay.connect();

  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    getTelemetryExportCounts: () => transport.getDiagnostics(),
    setIntervalFn: heartbeat.setIntervalFn,
    clearIntervalFn: () => {
      // The handle is never reclaimed; stop() has its own coverage.
    },
    logWarning: () => {
      // A swallowed emit failure surfaces as a missing record below.
    },
  });
  lifecycle.start();

  // Every counter ends on a DIFFERENT count (1..6), so a mapping that reads one
  // counter under another counter's attribute cannot pass.
  await send(transport, KEYLESS_TELEMETRY_MAX_BODY_BYTES + 1);
  for (let i = 0; i < 6; i++) {
    await send(transport);
  }
  heartbeat.tick();
  for (let i = 0; i < 5; i++) {
    relay.ackNext(KeylessTelemetryRejectionReason.PayloadTooLarge);
    await send(transport);
  }
  // One relay refusal, then two exports refused locally inside its cooldown.
  relay.ackNext(KeylessTelemetryRejectionReason.RateLimited);
  await send(transport);
  await send(transport);
  await send(transport);
  for (let i = 0; i < 4; i++) {
    relay.clock.now += COOLDOWN_SKIP_MS;
    relay.ackNext(KeylessTelemetryRejectionReason.CollectorUnavailable);
    await send(transport);
  }
  relay.clock.now += COOLDOWN_SKIP_MS;
  relay.dropLink();
  await send(transport);
  await send(transport);
  heartbeat.tick();
  lifecycle.stop();
  await transport.stop();

  assert.deepEqual(heartbeatExportCounts(runtime), [
    exportCounts({ sent: 6, droppedOversize: 1 }),
    exportCounts({
      sent: 6,
      droppedOversize: 1,
      droppedNoSession: 2,
      droppedRateLimited: 3,
      droppedCollectorUnavailable: 4,
      droppedInvalid: 5,
    }),
  ]);
});

test("start and shutdown carry no export counts, because they are sampled spans", async () => {
  const runtime = createTestRuntime();
  await runtime.start();

  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    getTelemetryExportCounts: () => ({
      sent: 6,
      droppedOversize: 1,
      droppedNoSession: 2,
      droppedRateLimited: 3,
      droppedCollectorUnavailable: 4,
      droppedInvalid: 5,
    }),
    setIntervalFn: manualHeartbeat().setIntervalFn,
    clearIntervalFn: () => {
      // See above.
    },
    logWarning: () => {
      // See above.
    },
  });

  lifecycle.start();
  lifecycle.emitShutdown();

  const boundarySpans = collectAppLifecycleRecords(
    runtime,
    DesktopOtelSignal.Trace
  );
  assert.equal(boundarySpans.length, 2);
  for (const record of boundarySpans) {
    for (const attribute of EXPORT_COUNT_ATTRIBUTES) {
      assert.equal(attribute in (record.attributes ?? {}), false);
    }
  }
});

test("a build with no relay transport omits the counts rather than reporting zeros", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const heartbeat = manualHeartbeat();

  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    setIntervalFn: heartbeat.setIntervalFn,
    clearIntervalFn: () => {
      // See above.
    },
    logWarning: () => {
      // See above.
    },
  });

  lifecycle.start();
  heartbeat.tick();
  lifecycle.stop();

  const beats = collectAppLifecycleRecords(runtime, DesktopOtelSignal.Log);
  assert.equal(beats.length, 1);
  for (const attribute of EXPORT_COUNT_ATTRIBUTES) {
    assert.equal(attribute in (beats[0].attributes ?? {}), false);
  }
});

function exportCounts(
  counts: Partial<DesktopTelemetryExportCounts>
): Record<string, number> {
  return {
    [TelemetryAttribute.AppTelemetryExportSentCount]: counts.sent ?? 0,
    [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]:
      counts.droppedOversize ?? 0,
    [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]:
      counts.droppedNoSession ?? 0,
    [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]:
      counts.droppedRateLimited ?? 0,
    [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]:
      counts.droppedCollectorUnavailable ?? 0,
    [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]:
      counts.droppedInvalid ?? 0,
  };
}

function heartbeatExportCounts(
  runtime: DesktopOtelRuntime
): Record<string, unknown>[] {
  return collectAppLifecycleRecords(runtime, DesktopOtelSignal.Log).map(
    (record) =>
      Object.fromEntries(
        EXPORT_COUNT_ATTRIBUTES.map((attribute) => [
          attribute,
          record.attributes?.[attribute],
        ])
      )
  );
}

/** Past any relay-requested cooldown and session TTL in one step. */
const COOLDOWN_SKIP_MS = 60 * 60 * 1000;

function send(
  transport: ReturnType<typeof createRelayTelemetryTransport>,
  bytes = 1
): Promise<boolean> {
  return transport.export(KeylessTelemetrySignal.Logs, new Uint8Array(bytes));
}

/**
 * A relay that accepts every handshake and answers each export with the next
 * scripted rejection, acking synchronously so no timer is involved.
 */
function scriptedRelay() {
  const clock = { now: 10_000 };
  const acks: KeylessTelemetryExportAck[] = [];
  const listeners = new Map<string, () => void>();
  let connected = false;
  const socket: TelemetrySocketLike = {
    get connected() {
      return connected;
    },
    on: (event, listener) => {
      listeners.set(event, () => listener());
    },
    emit: (event, _payload, ack) => {
      if (typeof ack !== "function") {
        return;
      }
      if (event === KEYLESS_TELEMETRY_HANDSHAKE_EVENT) {
        ack({
          accepted: true,
          sessionId: "sess-1",
          exportEvent: KEYLESS_TELEMETRY_EXPORT_EVENT,
          acceptedSignals: [KeylessTelemetrySignal.Logs],
          maxBodyBytes: KEYLESS_TELEMETRY_MAX_BODY_BYTES,
          ttlMs: 300_000,
        });
      } else {
        ack(acks.shift() ?? { accepted: true });
      }
    },
    disconnect: () => undefined,
    removeAllListeners: () => listeners.clear(),
  };
  return {
    clock,
    socket,
    connect: () => {
      connected = true;
      listeners.get("connect")?.();
    },
    /** Drop the link without firing `disconnect`, so the stale session is kept. */
    dropLink: () => {
      connected = false;
    },
    ackNext: (reason: KeylessTelemetryRejectionReason) => {
      acks.push({ accepted: false, reason });
    },
  };
}
