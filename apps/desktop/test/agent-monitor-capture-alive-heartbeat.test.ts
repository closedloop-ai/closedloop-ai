/**
 * ISS-9082: the lifecycle heartbeat must say whether CAPTURE is alive, not only
 * that the process is.
 *
 * The failure this exists for emitted 559 healthy heartbeats in a day on the one
 * release whose Agent Monitor was dead (ISS-8906). Every other desktop capture
 * signal is a work OUTCOME, and an install that ran no agent sessions produces
 * exactly what an install whose capture never came up produces — so nothing here
 * asserts that a heartbeat FIRES. It already fires; that is the defect. What is
 * asserted is that the heartbeat carries a status that differs between the two.
 */
import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { afterEach, test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import {
  AgentMonitorRuntimeStatusKind,
  READY_AGENT_MONITOR_RUNTIME_STATUS,
  resolveCaptureLivenessStatus,
  STARTING_AGENT_MONITOR_RUNTIME_STATUS,
} from "../src/shared/agent-monitor-status.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectAppLifecycleRecords,
  createTrackedRuntimeFactory,
  manualHeartbeat,
} from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(resetTrackedRuntime);

test("the heartbeat reports a capture status that tracks the runtime, not the process", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const heartbeat = manualHeartbeat();
  // Read through a mutable binding so a status captured once at `start()` —
  // which is the shape a boot-time snapshot would take — reports the second
  // tick as `ready` and fails here.
  let captureStatus: AgentMonitorRuntimeStatusKind =
    AgentMonitorRuntimeStatusKind.Ready;

  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    getAgentMonitorRuntimeStatus: () => captureStatus,
    setIntervalFn: heartbeat.setIntervalFn,
    clearIntervalFn: () => {
      // The timer handle is never reclaimed here; `stop()` behavior has its own
      // coverage in app-otel-runtime.test.ts.
    },
    logWarning: () => {
      // Emit failures would be swallowed anyway; a red assertion is the report.
    },
  });

  lifecycle.start();
  heartbeat.tick();
  captureStatus = AgentMonitorRuntimeStatusKind.Failed;
  heartbeat.tick();
  lifecycle.stop();

  assert.deepEqual(heartbeatCaptureStatuses(runtime), [
    AgentMonitorRuntimeStatusKind.Ready,
    AgentMonitorRuntimeStatusKind.Failed,
  ]);
});

test("start and shutdown carry no capture status, because neither has a verdict yet", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const heartbeat = manualHeartbeat();

  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    getAgentMonitorRuntimeStatus: () => AgentMonitorRuntimeStatusKind.Failed,
    setIntervalFn: heartbeat.setIntervalFn,
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
    const attributes = record.attributes ?? {};
    // Absent, not `null`: an explicit null is a value an older consumer must
    // interpret, and the cross-repo contract is omission.
    assert.equal(
      TelemetryAttribute.AppAgentMonitorRuntimeStatus in attributes,
      false
    );
  }
});

test("a caller that supplies no status still emits an unannotated heartbeat", async () => {
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

  // The liveness signal an already-installed build emits must keep landing: the
  // new attribute is additive, so its absence degrades to the pre-ISS-9082
  // heartbeat rather than dropping the record.
  const beats = collectAppLifecycleRecords(runtime, DesktopOtelSignal.Log);
  assert.equal(beats.length, 1);
  assert.deepEqual(heartbeatCaptureStatuses(runtime), [undefined]);
});

function heartbeatCaptureStatuses(runtime: DesktopOtelRuntime): unknown[] {
  return collectAppLifecycleRecords(runtime, DesktopOtelSignal.Log).map(
    (record) =>
      record.attributes?.[TelemetryAttribute.AppAgentMonitorRuntimeStatus]
  );
}

/**
 * ISS-9082 review (synchronizing-susan, Bug Hunter A): the DB-runtime `kind`
 * alone is NOT "is capture alive".
 *
 * `bootstrapAgentDashboardRuntime` sets `ready` as soon as the DB runtime
 * resolves, while the hook listener that actually receives agent events is
 * started fire-and-forget and RESOLVES on a bind failure rather than rejecting
 * — routing that failure to a separate terminal-failure flag. So a port
 * collision leaves `kind` latched at `ready` for the life of the process, and a
 * heartbeat reading only `kind` would report the dead install as healthy: the
 * exact ISS-8906 shape this feature exists to refuse.
 */
test("a terminal capture failure is reported even while the DB runtime still reads ready", () => {
  assert.equal(
    resolveCaptureLivenessStatus(READY_AGENT_MONITOR_RUNTIME_STATUS, true),
    AgentMonitorRuntimeStatusKind.Failed
  );
  assert.equal(
    resolveCaptureLivenessStatus(STARTING_AGENT_MONITOR_RUNTIME_STATUS, true),
    AgentMonitorRuntimeStatusKind.Failed
  );
});

test("with no terminal capture failure the DB runtime verdict is passed through unchanged", () => {
  assert.equal(
    resolveCaptureLivenessStatus(READY_AGENT_MONITOR_RUNTIME_STATUS, false),
    AgentMonitorRuntimeStatusKind.Ready
  );
  assert.equal(
    resolveCaptureLivenessStatus(STARTING_AGENT_MONITOR_RUNTIME_STATUS, false),
    AgentMonitorRuntimeStatusKind.Starting
  );
});
