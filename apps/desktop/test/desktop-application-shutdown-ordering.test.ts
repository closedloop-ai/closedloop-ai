/**
 * @file desktop-application-shutdown-ordering.test.ts
 * @description ISS-6711 — pin the teardown ORDER `runDesktopApplicationShutdown`
 * encodes. Its neighbours (`shutdown.ts`, `sync-lane-quiesce.ts`) were covered;
 * the orchestrator that sequences them was not, so three separately-fixed
 * production incidents survived only as comments:
 *
 *  - ISS-4713 — `beginClosing()` opens the db-host intentional-shutdown window
 *    and must run FIRST. Behind it, a db-host exit is relabelled "exited
 *    unexpectedly" and can trigger a mid-shutdown restart.
 *  - ISS-4623 — `disposeAuthSessionLaneRecovery()` must run BEFORE the lanes are
 *    stopped, or a late auth-state notification re-arms a given-up lane during
 *    teardown. (ISS-11449 retired its sibling, the org-policy store dispose,
 *    along with the policy.)
 *  - ISS-4903 — `quiesceDesktopSyncLanes()` must run BEFORE `runtime.close()`,
 *    or an in-flight drain lands a write on an already-disposed db-host proxy.
 *
 * Every collaborator is faked onto ONE shared call-order array, and the happy
 * path asserts that whole sequence. "Each mock was called" is the false green
 * here: every mock is called on the happy path in any order, and order is the
 * only thing all three incidents were about.
 *
 * The failure legs cover the two states the orchestrator must not launder:
 * a lane that did not drain (seeded into the sequence as a prior incomplete
 * phase, so the verdict cannot be `clean`), and a rejecting teardown phase
 * (reported with `duringUpdate` read from the LIVE update-apply flag — the
 * getter indirection exists precisely so a flag flipped mid-shutdown is
 * observed, and a fake that cannot flip would re-green that bug).
 *
 * No wall-clock dependence: the lane budget is expressed by the fake lane's
 * return value, the bounded async fakes settle on the next macrotask rather
 * than after a delay, and no fake outlives either deadline inside
 * `runShutdownSequence`.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { CloudCommandExecutor } from "../src/main/cloud/cloud-command-executor.js";
import type { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import type { CostReconciliationService } from "../src/main/cost/cost-reconciliation-service.js";
import type { AgentDashboardDesignSystemRuntime } from "../src/main/dashboard/agent-dashboard-design-system-runtime.js";
import {
  type DesktopApplicationShutdownDeps,
  runDesktopApplicationShutdown,
  SIGN_IN_RELEASE_BUDGET_MS,
} from "../src/main/lifecycle/desktop-application-shutdown.js";
import type { ShutdownResult } from "../src/main/lifecycle/shutdown.js";
import {
  QuiesceOutcome,
  TRANSCRIPT_SYNC_LANE_NAME,
} from "../src/main/lifecycle/sync-lane-quiesce.js";
import type {
  DesktopAppExceptionEventInput,
  DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { processExceptionTelemetryBridge } from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import type {
  DesktopShutdownDiagnostics,
  DesktopShutdownTrigger,
} from "../src/main/telemetry/telemetry-protocol.js";
import type { DesktopTray } from "../src/main/tray.js";
import type { DesktopWindow } from "../src/main/window.js";
import type { DesktopGatewayServer } from "../src/server/server.js";
import { deferred } from "./deferred.js";

/**
 * One token per collaborator call, appended to a single shared array. Distinct
 * per step so the recorded sequence can only be satisfied by one ordering.
 */
const Step = {
  RuntimeBeginClosing: "runtime.beginClosing",
  ReleaseSignIn: "releaseSignIn",
  ReleaseSignInSettled: "releaseSignIn:settled",
  QueueStatsCancel: "queueStatsTelemetryDebounce.cancel",
  DisposeAuthSessionLaneRecovery: "disposeAuthSessionLaneRecovery",
  RealtimeHostDispose: "realtimeHost.dispose",
  StopAgentCapture: "stopAgentCapture",
  StopAgentCaptureSettled: "stopAgentCapture:settled",
  CostReconciliationStop: "costReconciliation.stop",
  TranscriptSyncQuiesce: TRANSCRIPT_SYNC_LANE_NAME,
  TranscriptSyncQuiesceSettled: `${TRANSCRIPT_SYNC_LANE_NAME}:settled`,
  RuntimeClose: "runtime.close",
  RuntimeCloseSettled: "runtime.close:settled",
  UpdateTelemetryFlush: "updateTelemetry.flushPendingTerminalRecord",
  UpdateTelemetryInstallStarted: "updateTelemetry.installStarted",
  UpdateTelemetryRestartInitiated: "updateTelemetry.restartInitiated",
  LifecycleTelemetryStop: "appLifecycleTelemetry.stop",
  LifecycleTelemetryEmitShutdown: "appLifecycleTelemetry.emitShutdown",
  OtelRuntimeShutdown: "appOtelRuntime.shutdown",
  OtelRuntimeShutdownSettled: "appOtelRuntime.shutdown:settled",
  UnregisterDisabledDbIpc: "unregisterDisabledAgentDashboardDbIpcHandlers",
  GetUpdateCheckTimer: "getUpdateCheckTimer",
  ClearUpdateCheckTimer: "clearUpdateCheckTimer",
  TelemetryFlush: "observability.shutdown",
  CloudSocketStop: "cloudSocket.stop",
  CommandExecutorDispose: "commandExecutor.dispose",
  ServerStop: "server.stop",
  DesktopWindowDispose: "desktopWindow.dispose",
  TrayDispose: "tray.dispose",
} as const;
type Step = (typeof Step)[keyof typeof Step];

/** Phase name `runShutdownSequence` gives the capture-teardown phase. */
const AGENT_MONITOR_PHASE = "agentMonitor.stop";
/** Trigger the orchestrator stamps on a phase-sequence failure. */
const SHUTDOWN_SEQUENCE_TRIGGER: DesktopShutdownTrigger = "shutdown-sequence";

/**
 * The full happy-path order, including the phases `runShutdownSequence` runs.
 * Every incident-critical relationship this file exists to protect is a pair of
 * neighbours somewhere in this list.
 *
 * The `:settled` tokens are load-bearing. Every fake records at INVOCATION, and
 * a dropped `await` still invokes in the same order — so invocation tokens alone
 * cannot tell "drained the lane, then closed the db-host" from "kicked the drain
 * and closed the db-host underneath it", which is the actual shape of ISS-4903.
 * The bounded async steps therefore also record when they SETTLE, a macrotask
 * later, and a fire-and-forget regression shows up here as a reordering.
 */
const EXPECTED_HAPPY_PATH: readonly Step[] = [
  Step.RuntimeBeginClosing,
  Step.ReleaseSignIn,
  Step.ReleaseSignInSettled,
  Step.QueueStatsCancel,
  Step.DisposeAuthSessionLaneRecovery,
  Step.RealtimeHostDispose,
  Step.StopAgentCapture,
  Step.StopAgentCaptureSettled,
  Step.CostReconciliationStop,
  Step.TranscriptSyncQuiesce,
  Step.TranscriptSyncQuiesceSettled,
  Step.RuntimeClose,
  Step.RuntimeCloseSettled,
  // ISS-7247: both update records must be emitted ABOVE the OTel shutdown
  // below, which is the call that flushes the exporter. Emitting them after
  // it — in `finishUpdateInstall()`, the natural-looking home — would drop
  // them on a dead runtime.
  Step.UpdateTelemetryFlush,
  Step.LifecycleTelemetryStop,
  Step.LifecycleTelemetryEmitShutdown,
  Step.OtelRuntimeShutdown,
  Step.OtelRuntimeShutdownSettled,
  Step.UnregisterDisabledDbIpc,
  Step.GetUpdateCheckTimer,
  Step.ClearUpdateCheckTimer,
  Step.TelemetryFlush,
  Step.CloudSocketStop,
  Step.CommandExecutorDispose,
  Step.StopAgentCapture,
  Step.StopAgentCaptureSettled,
  Step.ServerStop,
  Step.DesktopWindowDispose,
  Step.TrayDispose,
];

type HarnessOptions = {
  /** Outcome the single wired lane reports. Default: it drained. */
  laneOutcome?: QuiesceOutcome;
  /** No lane at all (feature off / never constructed). */
  withoutTranscriptSync?: boolean;
  /**
   * Per-invocation behavior for `stopAgentCapture`, which the orchestrator
   * calls twice (once before the lane drain, once as the `agentMonitor.stop`
   * phase). Index is 0-based; returning a rejection drives the failure leg.
   */
  stopAgentCapture?: (invocation: number) => Promise<void>;
  /** Runs after each recorded step, so a test can mutate live app state. */
  onStep?: (step: Step) => void;
  /** Drop the runtime handle after `stopAgentCapture`, as the app itself does. */
  dropRuntimeAfterCapture?: boolean;
  /** No dashboard runtime at all: the feature is off, so it was never built. */
  withoutRuntime?: boolean;
  /**
   * The application's live update-apply flag. Passed in (rather than only read
   * back) so a test can flip it mid-shutdown from `onStep`.
   */
  applyingUpdate?: { value: boolean };
  packagedUpdateVersion?: { value: string | undefined };
  /**
   * Held by `appOtelRuntime.shutdown()` in place of its default one-macrotask
   * settle, so a test can act while that drain is genuinely still in flight.
   * Receives the live call log.
   */
  otelShutdownGate?: (calls: readonly Step[]) => Promise<void>;
  /** Replaces the sign-in release's default one-macrotask settle. */
  releaseSignInGate?: () => Promise<void>;
};

type Harness = {
  deps: DesktopApplicationShutdownDeps;
  calls: Step[];
  shutdownDiagnostics: DesktopShutdownDiagnostics[];
  /** ISS-7247: target versions the orchestrator armed a restart expectation for. */
  restartInitiatedVersions: (string | undefined)[];
  /** ISS-7247: target versions the orchestrator reported an install start for. */
  installStartedVersions: (string | undefined)[];
  /**
   * The very OTel runtime this shutdown tears down, so the exception bridge can
   * be bound to it exactly as the application binds it.
   */
  appOtelRuntime: DesktopOtelRuntime;
  /** Exceptions the bridge routed into that runtime, in order. */
  otelExceptions: unknown[];
};

function createHarness(options: HarnessOptions = {}): Harness {
  const calls: Step[] = [];
  const shutdownDiagnostics: DesktopShutdownDiagnostics[] = [];
  const applyingUpdate = options.applyingUpdate ?? { value: false };
  const packagedUpdateVersion = options.packagedUpdateVersion ?? {
    value: undefined as string | undefined,
  };
  const restartInitiatedVersions: (string | undefined)[] = [];
  const installStartedVersions: (string | undefined)[] = [];
  let captureInvocations = 0;
  let runtimeDropped = options.withoutRuntime === true;

  const record = (step: Step): void => {
    calls.push(step);
    options.onStep?.(step);
  };

  // The real transport is a no-op; both hooks exist only to observe. The flush
  // hook is what makes the optional `observability.shutdown` phase visible in
  // the recorded sequence rather than an untracked gap.
  Observability.init({
    telemetrySend: (event) => {
      const diagnostics = event.diagnostics?.desktopShutdown;
      if (diagnostics) {
        shutdownDiagnostics.push(diagnostics);
      }
    },
    telemetryFlush: () => {
      record(Step.TelemetryFlush);
      return Promise.resolve();
    },
  });

  // `close()` is not a marker call: it runs the bounded db-host drain and only
  // then disposes the proxy, so it settles a macrotask after it is invoked. A
  // fake that resolved immediately would record the same sequence whether or
  // not the orchestrator awaited it, which is precisely ISS-4903's shape.
  const runtime = {
    beginClosing: () => record(Step.RuntimeBeginClosing),
    close: async () => {
      record(Step.RuntimeClose);
      await settleLater();
      record(Step.RuntimeCloseSettled);
    },
  } as AgentDashboardDesignSystemRuntime;

  // Same shape for the OTel drain, which awaits the SDK/exporter flush. It also
  // carries `emitAppExceptionEvent`, so the crash bridge can be bound to the
  // runtime this shutdown actually tears down rather than to a stand-in that
  // stays alive across the unbind under test.
  const otelExceptions: unknown[] = [];
  const appOtelRuntime = {
    emitAppExceptionEvent: (input: DesktopAppExceptionEventInput) => {
      otelExceptions.push(input.error);
    },
    flush: () => Promise.resolve(),
    shutdown: async () => {
      record(Step.OtelRuntimeShutdown);
      await (options.otelShutdownGate?.(calls) ?? settleLater());
      record(Step.OtelRuntimeShutdownSettled);
    },
  } as DesktopOtelRuntime;

  const deps: DesktopApplicationShutdownDeps = {
    getAgentDashboardRuntime: () => (runtimeDropped ? null : runtime),
    releaseSignIn: async () => {
      record(Step.ReleaseSignIn);
      await (options.releaseSignInGate?.() ?? settleLater());
      record(Step.ReleaseSignInSettled);
    },
    queueStatsTelemetryDebounce: {
      trigger: () => {
        throw new Error("queue stats telemetry must not be triggered on quit");
      },
      cancel: () => record(Step.QueueStatsCancel),
    },
    disposeAuthSessionLaneRecovery: () =>
      record(Step.DisposeAuthSessionLaneRecovery),
    stopAgentCapture: async () => {
      const invocation = captureInvocations;
      captureInvocations += 1;
      record(Step.StopAgentCapture);
      if (options.dropRuntimeAfterCapture) {
        runtimeDropped = true;
      }
      await settleLater();
      await options.stopAgentCapture?.(invocation);
      record(Step.StopAgentCaptureSettled);
    },
    costReconciliation: {
      stop: () => record(Step.CostReconciliationStop),
    } as CostReconciliationService,
    transcriptSync: options.withoutTranscriptSync
      ? null
      : {
          quiesce: async () => {
            record(Step.TranscriptSyncQuiesce);
            await settleLater();
            record(Step.TranscriptSyncQuiesceSettled);
            return options.laneOutcome ?? QuiesceOutcome.Drained;
          },
        },
    updateTelemetry: {
      checked: () => undefined,
      checkFailed: () => undefined,
      available: () => undefined,
      downloadStarted: () => undefined,
      downloadSucceeded: () => undefined,
      downloadFailed: () => undefined,
      installBlocked: () => undefined,
      installStarted: (toVersion) => {
        installStartedVersions.push(toVersion);
        record(Step.UpdateTelemetryInstallStarted);
      },
      restartInitiated: (toVersion) => {
        restartInitiatedVersions.push(toVersion);
        record(Step.UpdateTelemetryRestartInitiated);
      },
      onBoot: () => {
        throw new Error("update telemetry must not reconcile a boot on quit");
      },
      flushPendingTerminalRecord: () => record(Step.UpdateTelemetryFlush),
    },
    getUpdateRestartTargetVersion: () => packagedUpdateVersion.value,
    appLifecycleTelemetry: {
      start: () => {
        throw new Error("lifecycle telemetry must not be started on quit");
      },
      stop: () => record(Step.LifecycleTelemetryStop),
      emitShutdown: () => record(Step.LifecycleTelemetryEmitShutdown),
    },
    appOtelRuntime,
    unregisterDisabledAgentDashboardDbIpcHandlers: () =>
      record(Step.UnregisterDisabledDbIpc),
    getUpdateCheckTimer: () => {
      record(Step.GetUpdateCheckTimer);
      return null;
    },
    clearUpdateCheckTimer: () => record(Step.ClearUpdateCheckTimer),
    cloudSocket: {
      stop: () => record(Step.CloudSocketStop),
    } as CloudSocketService,
    realtimeHost: { dispose: () => record(Step.RealtimeHostDispose) },
    commandExecutor: {
      dispose: () => record(Step.CommandExecutorDispose),
    } as CloudCommandExecutor,
    server: {
      stop: () => {
        record(Step.ServerStop);
        return Promise.resolve();
      },
    } as DesktopGatewayServer,
    desktopWindow: {
      dispose: () => record(Step.DesktopWindowDispose),
    } as DesktopWindow,
    tray: { dispose: () => record(Step.TrayDispose) } as DesktopTray,
    isApplyingUpdate: () => applyingUpdate.value,
    log: () => undefined,
    logWarning: () => undefined,
  };

  return {
    deps,
    calls,
    shutdownDiagnostics,
    restartInitiatedVersions,
    installStartedVersions,
    appOtelRuntime,
    otelExceptions,
  };
}

/**
 * Settle a macrotask later than the caller, so a step the orchestrator kicked
 * off without awaiting records its completion AFTER whatever ran underneath it.
 */
function settleLater(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** One "`earlier` must run before `later`, because `reason`" requirement. */
type OrderRequirement = readonly [earlier: Step, later: Step, reason: string];

/**
 * The requirements `calls` violates, as reader-facing messages, empty when the
 * recorded order satisfies every one. Positions are FIRST occurrences: the
 * capture teardown runs twice and every incident-critical relationship is
 * against its pre-sequence call.
 */
function orderViolations(
  calls: readonly Step[],
  requirements: readonly OrderRequirement[]
): string[] {
  const recorded = `recorded: ${calls.join(" -> ")}`;
  const violations: string[] = [];
  for (const [earlier, later, reason] of requirements) {
    const earlierIndex = calls.indexOf(earlier);
    const laterIndex = calls.indexOf(later);
    if (earlierIndex === -1) {
      violations.push(`${earlier} never ran (${recorded})`);
    } else if (laterIndex === -1) {
      violations.push(`${later} never ran (${recorded})`);
    } else if (earlierIndex > laterIndex) {
      violations.push(
        `${earlier} must run before ${later} — ${reason} (${recorded})`
      );
    }
  }
  return violations;
}

afterEach(() => {
  vi.useRealTimers();
  Observability.reset();
  // The bridge is a module singleton: leave it unbound for the next test.
  processExceptionTelemetryBridge.clearRuntime();
});

describe("runDesktopApplicationShutdown ordering", () => {
  test("drives the whole teardown in one fixed order", async () => {
    const harness = createHarness();

    const result: ShutdownResult = await runDesktopApplicationShutdown(
      harness.deps
    );

    assert.equal(result, "clean");
    // The full sequence, not "each collaborator was called": every one of them
    // is called on any ordering of this body, and ordering is the whole subject.
    assert.deepEqual(harness.calls, EXPECTED_HAPPY_PATH);
  });

  test("ISS-4713: opens the db-host shutdown window before any teardown", async () => {
    const harness = createHarness();

    await runDesktopApplicationShutdown(harness.deps);

    assert.equal(
      harness.calls[0],
      Step.RuntimeBeginClosing,
      "beginClosing must be the first thing shutdown does; behind any teardown step, a db-host exit is relabelled as an unexpected exit"
    );
    assert.deepEqual(
      orderViolations(harness.calls, [
        [
          Step.RuntimeBeginClosing,
          Step.StopAgentCapture,
          "the capture teardown still drives db-host writes",
        ],
        [
          Step.RuntimeBeginClosing,
          Step.RuntimeClose,
          "close() runs the bounded db-host drain inside the intentional-shutdown window",
        ],
      ]),
      []
    );
  });

  test("ISS-4623: drops the auth-session lane-recovery seam before the lanes stop", async () => {
    const harness = createHarness();

    await runDesktopApplicationShutdown(harness.deps);

    assert.deepEqual(
      orderViolations(harness.calls, [
        [
          Step.DisposeAuthSessionLaneRecovery,
          Step.StopAgentCapture,
          "an auth-state notification arriving after lane stop re-arms a given-up lane during teardown",
        ],
        [
          Step.DisposeAuthSessionLaneRecovery,
          Step.TranscriptSyncQuiesce,
          "a re-arm during the drain would put new work back in the air",
        ],
      ]),
      []
    );
  });

  test("ISS-4903: drains the sync lanes before the db-host proxy is closed", async () => {
    const harness = createHarness();

    await runDesktopApplicationShutdown(harness.deps);

    // The SETTLED token, not the invocation: the incident was a drain still in
    // the air when close() ran, which a fire-and-forget kick reproduces exactly.
    assert.deepEqual(
      orderViolations(harness.calls, [
        [
          Step.TranscriptSyncQuiesceSettled,
          Step.RuntimeClose,
          "a tick already in the air lands its write on an already-disposed db-host proxy",
        ],
        [
          Step.StopAgentCaptureSettled,
          Step.TranscriptSyncQuiesce,
          "the drain is only bounded once the lane timers have stopped issuing new work",
        ],
        [
          Step.RuntimeCloseSettled,
          Step.LifecycleTelemetryStop,
          "close() runs the bounded db-host drain itself, so the teardown behind it must not start while that drain is still in the air",
        ],
      ]),
      []
    );
  });

  test("a lane that drained leaves the verdict clean and reports nothing", async () => {
    const harness = createHarness({ laneOutcome: QuiesceOutcome.Drained });

    const result = await runDesktopApplicationShutdown(harness.deps);

    // Negative control for the un-quiesced leg below: without it, that test
    // would pass against an orchestrator that reported a failure unconditionally.
    assert.equal(result, "clean");
    assert.deepEqual(harness.shutdownDiagnostics, []);
  });

  test("an un-quiesced lane is seeded into the phase sequence, not swallowed", async () => {
    const harness = createHarness({ laneOutcome: QuiesceOutcome.TimedOut });

    const result = await runDesktopApplicationShutdown(harness.deps);

    assert.equal(result, "timed_out");
    assert.equal(harness.shutdownDiagnostics.length, 1);
    const [diagnostics] = harness.shutdownDiagnostics;
    assert.equal(
      diagnostics?.phase,
      TRANSCRIPT_SYNC_LANE_NAME,
      "the lane that did not drain is the earliest incomplete phase and must be the one reported"
    );
    assert.equal(diagnostics?.result, "timed_out");
    assert.equal(diagnostics?.trigger, SHUTDOWN_SEQUENCE_TRIGGER);
    // Degrading the verdict must not abort the teardown: the remaining phases
    // still ran to the end.
    assert.equal(harness.calls.at(-1), Step.TrayDispose);
  });

  test("no dashboard runtime at all is not an error", async () => {
    // The runtime is absent whenever the feature never started. Both reads are
    // optional-chained, and shutdown must still complete every other step.
    const harness = createHarness({ withoutRuntime: true });

    const result = await runDesktopApplicationShutdown(harness.deps);

    assert.equal(result, "clean");
    assert.ok(!harness.calls.includes(Step.RuntimeBeginClosing));
    assert.ok(!harness.calls.includes(Step.RuntimeClose));
    assert.equal(harness.calls[0], Step.ReleaseSignIn);
    assert.equal(harness.calls.at(-1), Step.TrayDispose);
  });

  test("no lane wired at all drains vacuously", async () => {
    const harness = createHarness({ withoutTranscriptSync: true });

    const result = await runDesktopApplicationShutdown(harness.deps);

    assert.equal(result, "clean");
    assert.ok(!harness.calls.includes(Step.TranscriptSyncQuiesce));
    assert.deepEqual(harness.shutdownDiagnostics, []);
  });

  test("ISS-11345: a sign-in release that never settles cannot hold the quit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reached = deferred();
    const harness = createHarness({
      releaseSignInGate: () => {
        reached.resolve();
        return new Promise(() => undefined);
      },
    });

    const shutdown = runDesktopApplicationShutdown(harness.deps);
    await reached.promise;
    await vi.advanceTimersByTimeAsync(SIGN_IN_RELEASE_BUDGET_MS);

    assert.equal(await shutdown, "clean");
    assert.ok(!harness.calls.includes(Step.ReleaseSignInSettled));
    assert.equal(harness.calls.at(-1), Step.TrayDispose);
  }, 10_000);
});

describe("runDesktopApplicationShutdown failure reporting", () => {
  /**
   * The capture teardown runs twice — once inline, once as the
   * `agentMonitor.stop` phase — and only the phase invocation is inside the
   * sequence's own error handling. Rejecting the second one is the reachable
   * failure-report path; the first one is covered separately below.
   */
  const rejectOnPhaseInvocation = (message: string) => (invocation: number) =>
    invocation === 0 ? Promise.resolve() : Promise.reject(new Error(message));

  test("stamps duringUpdate from the update flag as it stands when the failure is reported", async () => {
    const errorMessage = "agent capture stop failed";
    // The flag is false when shutdown starts and flips part-way through, which
    // is what `setApplyingDownloadedUpdate` does when an update-apply request
    // arrives during a quit already in flight. It flips INSIDE the phase
    // sequence — every phase is bounded at 3s, so that window is the long part
    // of a quit — which is what makes the report-time read the only production
    // shape that satisfies this: a getter hoisted anywhere before the sequence
    // (function entry, or a local taken just before the call) still reports false.
    const applyingUpdate = { value: false };
    const harness = createHarness({
      applyingUpdate,
      stopAgentCapture: rejectOnPhaseInvocation(errorMessage),
      onStep: (step) => {
        if (step === Step.CloudSocketStop) {
          applyingUpdate.value = true;
        }
      },
    });

    assert.equal(applyingUpdate.value, false, "flag starts down");
    const result = await runDesktopApplicationShutdown(harness.deps);

    assert.equal(result, "failed");
    assert.equal(harness.shutdownDiagnostics.length, 1);
    const [diagnostics] = harness.shutdownDiagnostics;
    assert.equal(diagnostics?.duringUpdate, true);
    assert.equal(diagnostics?.phase, AGENT_MONITOR_PHASE);
    assert.equal(diagnostics?.result, "failed");
    assert.equal(diagnostics?.trigger, SHUTDOWN_SEQUENCE_TRIGGER);
    assert.equal(diagnostics?.error, errorMessage);
  });

  test("an update-triggered quit persists the restart expectation before the OTel flush", async () => {
    // ISS-7247: `restart_initiated` is the last thing the OLD process can
    // honestly say, and it is only useful if it (and the from->to expectation it
    // persists) get out before the exporter is torn down.
    const harness = createHarness({
      applyingUpdate: { value: true },
      packagedUpdateVersion: { value: "0.16.1451" },
    });

    await runDesktopApplicationShutdown(harness.deps);

    assert.deepEqual(harness.restartInitiatedVersions, ["0.16.1451"]);
    assert.deepEqual(harness.installStartedVersions, ["0.16.1451"]);
    const flushIndex = harness.calls.indexOf(Step.UpdateTelemetryFlush);
    const restartIndex = harness.calls.indexOf(
      Step.UpdateTelemetryRestartInitiated
    );
    const otelShutdownIndex = harness.calls.indexOf(Step.OtelRuntimeShutdown);
    assert.notEqual(restartIndex, -1, "the restart record was never emitted");
    assert.equal(
      restartIndex < otelShutdownIndex,
      true,
      "restart_initiated was emitted after the OTel runtime shut down"
    );
    // Flush FIRST. Reversed, arming this quit's expectation would be erased by
    // the settling write for the previous one — which is what a chained upgrade
    // (boot into v2 with a pending v1->v2, then apply v2->v3) actually does,
    // and v2->v3 would then never get a terminal record.
    assert.equal(
      flushIndex < restartIndex,
      true,
      "the pending attempt was settled AFTER this quit armed a new one"
    );
  });

  test("a quit that is not applying an update emits no restart expectation", async () => {
    // Pairs with the test above: the record comes from the flag, not from a
    // call the shutdown always makes. A stranded expectation written on every
    // ordinary quit would make the next launch report a phantom failed upgrade.
    const harness = createHarness();

    await runDesktopApplicationShutdown(harness.deps);

    assert.deepEqual(harness.restartInitiatedVersions, []);
    assert.deepEqual(harness.installStartedVersions, []);
    assert.equal(
      harness.calls.includes(Step.UpdateTelemetryRestartInitiated),
      false
    );
  });

  test("stamps duringUpdate false for the same failure outside an update", async () => {
    const harness = createHarness({
      stopAgentCapture: rejectOnPhaseInvocation("agent capture stop failed"),
    });

    const result = await runDesktopApplicationShutdown(harness.deps);

    // Pairs with the test above: the `true` there comes from the flag, not from
    // a constant the reporter always stamps.
    assert.equal(result, "failed");
    assert.equal(harness.shutdownDiagnostics[0]?.duringUpdate, false);
  });

  test("a rejecting pre-sequence step is escalated, never reported as clean", async () => {
    const errorMessage = "capture teardown exploded";
    const harness = createHarness({
      stopAgentCapture: () => Promise.reject(new Error(errorMessage)),
    });

    // The before-quit handler owns this case (it reports `shutdown-rejected`
    // and force-exits), so the orchestrator must let it out rather than
    // swallowing it into a verdict that claims the teardown completed.
    await assert.rejects(runDesktopApplicationShutdown(harness.deps), {
      message: errorMessage,
    });
    assert.deepEqual(harness.shutdownDiagnostics, []);
    assert.ok(!harness.calls.includes(Step.TrayDispose));
  });
});

describe("runDesktopApplicationShutdown crash-telemetry bridge", () => {
  test("unbinds the exception bridge from the runtime it just shut down", async () => {
    const harness = createHarness();
    // Bound to the harness's OWN OTel runtime, the one this shutdown tears
    // down — a separate stand-in would outlive the teardown under test.
    processExceptionTelemetryBridge.bindRuntime(harness.appOtelRuntime);
    // Boot marks the runtime started once `start()` resolves (ISS-6330); without
    // that step the bridge is still in its pre-init window and would QUEUE these
    // shutdown-path crashes instead of emitting them, which is the downgrade the
    // assertions below exist to catch.
    processExceptionTelemetryBridge.markRuntimeStarted();
    // Control: while bound, a process exception does reach the runtime — so the
    // silence asserted after shutdown is the unbind, not an inert bridge.
    processExceptionTelemetryBridge.emitProcessException(
      new Error("crash before shutdown")
    );
    assert.equal(harness.otelExceptions.length, 1);

    await runDesktopApplicationShutdown(harness.deps);
    processExceptionTelemetryBridge.emitProcessException(
      new Error("crash after shutdown")
    );

    assert.equal(
      harness.otelExceptions.length,
      1,
      "a crash after teardown must not be emitted through the OTel runtime shutdown already tore down"
    );
  });

  test("keeps the bridge bound until the OTel drain it is tearing down has settled", async () => {
    const crashDuringOtelShutdown = new Error("crash during otel shutdown");
    let callsDuringDrain: readonly Step[] = [];
    const harness = createHarness({
      // The drain is held pending across several macrotasks, and the crash is
      // emitted from INSIDE that window rather than from the synchronous body
      // of the fake. A fire-and-forget `shutdownDesktopOtelRuntime(...)` would
      // have run `clearRuntime()` and every remaining phase by the time this
      // runs, so both assertions below fail on it.
      otelShutdownGate: async (calls) => {
        await settleLater();
        await settleLater();
        callsDuringDrain = [...calls];
        processExceptionTelemetryBridge.emitProcessException(
          crashDuringOtelShutdown
        );
      },
    });
    processExceptionTelemetryBridge.bindRuntime(harness.appOtelRuntime);
    // Boot marks the runtime started once `start()` resolves (ISS-6330); without
    // that step the bridge is still in its pre-init window and would QUEUE these
    // shutdown-path crashes instead of emitting them, which is the downgrade the
    // assertions below exist to catch.
    processExceptionTelemetryBridge.markRuntimeStarted();

    await runDesktopApplicationShutdown(harness.deps);

    // Pins the unbind's POSITION, which the recorded sequence cannot: the bridge
    // reaches through a module singleton rather than `deps`. Clearing it any
    // earlier downgrades a real main-process crash to a pre-init one.
    assert.deepEqual(harness.otelExceptions, [crashDuringOtelShutdown]);
    assert.equal(
      callsDuringDrain.at(-1),
      Step.OtelRuntimeShutdown,
      "no phase behind the OTel drain may run while that drain is still in flight"
    );
  });
});

describe("runDesktopApplicationShutdown runtime handle", () => {
  test("re-reads the runtime after capture teardown instead of holding a stale handle", async () => {
    // `stopAgentCapture({ closeDesignSystem: true })` closes the runtime and
    // nulls the application's field. A handle captured at entry would be closed
    // a second time here, on an object the app has already disposed.
    const harness = createHarness({ dropRuntimeAfterCapture: true });

    const result = await runDesktopApplicationShutdown(harness.deps);

    assert.equal(result, "clean");
    assert.ok(harness.calls.includes(Step.RuntimeBeginClosing));
    assert.ok(
      !harness.calls.includes(Step.RuntimeClose),
      "close() must not be driven through a handle the application already dropped"
    );
  });
});
