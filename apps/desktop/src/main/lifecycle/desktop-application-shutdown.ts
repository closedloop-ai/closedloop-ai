import type { DesktopGatewayServer } from "../../server/server.js";
import type { CloudCommandExecutor } from "../cloud/cloud-command-executor.js";
import type { CloudSocketService } from "../cloud/cloud-socket.js";
import type { CostReconciliationService } from "../cost/cost-reconciliation-service.js";
import type { AgentDashboardDesignSystemRuntime } from "../dashboard/agent-dashboard-design-system-runtime.js";
import type { DesktopRealtimeHost } from "../realtime/desktop-realtime-host.js";
import type { DesktopOtelRuntime } from "../telemetry/app-otel-runtime.js";
import type { DesktopAppLifecycleTelemetry } from "../telemetry/app-otel-runtime-lifecycle.js";
import { shutdownDesktopOtelRuntime } from "../telemetry/app-otel-runtime-lifecycle.js";
import { Observability } from "../telemetry/observability.js";
import { processExceptionTelemetryBridge } from "../telemetry/process-exception-telemetry-bridge.js";
import { raceShutdownDeadline } from "../telemetry/shutdown-deadline.js";
import type { DesktopShutdownDiagnostics } from "../telemetry/telemetry-protocol.js";
import type { DesktopTray } from "../tray.js";
import type { DesktopUpdateLifecycleReporter } from "../update/update-lifecycle-telemetry.js";
import type { QueueStatsDebounce } from "../util/queue-stats-debounce.js";
import type { DesktopWindow } from "../window.js";
import { runShutdownSequence, type ShutdownResult } from "./shutdown.js";
import {
  type QuiescibleSyncLaneService,
  quiesceDesktopSyncLanes,
} from "./sync-lane-quiesce.js";

/**
 * The application-owned collaborators the graceful-shutdown orchestration tears
 * down, plus the small set of app-state mutations it still has to drive.
 *
 * The runtime is read through a getter (rather than captured once) so the two
 * `?.` reads below observe the same live field the application owns — exactly
 * what the previous inline `this.agentDashboardDesignSystem?.…` calls did.
 */
export type DesktopApplicationShutdownDeps = {
  getAgentDashboardRuntime: () => AgentDashboardDesignSystemRuntime | null;
  /**
   * ISS-11345: cancels an in-flight browser sign-in and resolves once it has
   * revoked any session it held unadopted and closed its loopback listener.
   */
  releaseSignIn: () => Promise<void>;
  queueStatsTelemetryDebounce: QueueStatsDebounce;
  /**
   * Drops the app's handle on the auth-session lane-recovery seam, so a late
   * auth-state notification cannot re-arm a stopped lane. The seam's own callback
   * is shutdown-gated as a backstop.
   */
  disposeAuthSessionLaneRecovery: () => void;
  stopAgentCapture: () => Promise<void>;
  costReconciliation: CostReconciliationService;
  /**
   * ISS-4903: the transcript sync lane, quiesced between the capture teardown
   * and the db-host close so an in-flight drain/sweep/force-archive cannot land
   * a write on an already-disposed db-host proxy.
   */
  transcriptSync: QuiescibleSyncLaneService | null;
  appLifecycleTelemetry: DesktopAppLifecycleTelemetry;
  appOtelRuntime: DesktopOtelRuntime;
  /** ISS-7247 release-health reporter; settled here, before the OTel flush. */
  updateTelemetry: DesktopUpdateLifecycleReporter;
  /**
   * The version this quit will actually come back on, or undefined. Covers BOTH
   * an explicit apply and `autoInstallOnAppQuit`, which stages a downloaded
   * update on an ORDINARY quit — the common path, and the one that would
   * otherwise never arm an expectation and never be reported.
   */
  getUpdateRestartTargetVersion: () => string | undefined;
  unregisterDisabledAgentDashboardDbIpcHandlers: () => void;
  getUpdateCheckTimer: () => NodeJS.Timeout | null;
  clearUpdateCheckTimer: () => void;
  cloudSocket: CloudSocketService;
  realtimeHost: Pick<DesktopRealtimeHost, "dispose">;
  commandExecutor: CloudCommandExecutor;
  server: DesktopGatewayServer;
  desktopWindow: DesktopWindow;
  tray: DesktopTray;
  isApplyingUpdate: () => boolean;
  log: (message: string) => void;
  logWarning: (tag: string, message: string) => void;
};

/**
 * Shutdown failure telemetry raised by the app itself (the before-quit handler
 * routes its own failures through here). `duringUpdate` is stamped from the live
 * update-apply flag so a failure during the FEA-2026 updater handoff is
 * distinguishable from an ordinary quit.
 */
export function reportDesktopShutdownFailure(
  input: Omit<DesktopShutdownDiagnostics, "duringUpdate">,
  isApplyingUpdate: boolean
): void {
  Observability.desktopShutdownFailed({
    ...input,
    duringUpdate: isApplyingUpdate,
  });
}

/**
 * Graceful shutdown orchestration for {@link DesktopApplication}.
 *
 * Ordering here is shutdown-critical and intentionally sequential: the
 * capture/sync services that still drive db-host writes are quiesced BEFORE the
 * bounded phase sequence tears down the socket/server/window/tray, and the
 * db-host intentional-shutdown window is opened first of all so an exit from
 * here on is never relabeled "exited unexpectedly".
 */
export async function runDesktopApplicationShutdown(
  deps: DesktopApplicationShutdownDeps
): Promise<ShutdownResult> {
  // ISS-4713: mark the db-host intentional-shutdown window open FIRST, before
  // we tear down the capture/sync services that still drive db-host writes. A
  // db-host exit from here on is expected — it must not be relabeled "exited
  // unexpectedly" or trigger a mid-shutdown restart. The bounded, clean
  // db-host drain then runs inside the runtime's close() below.
  deps.getAgentDashboardRuntime()?.beginClosing();
  // ISS-11345: a crash never reaches here; the held session's server-side
  // expiry is what ends it then.
  await raceShutdownDeadline(deps.releaseSignIn(), SIGN_IN_RELEASE_BUDGET_MS);
  deps.queueStatsTelemetryDebounce.cancel();
  // ISS-4623: drop the auth-session lane-recovery handle BEFORE stopping the
  // lanes, so a late auth-state notification cannot re-arm a given-up lane into
  // stopped lanes while the cloud socket is still online (whitlockk review). The
  // seam's callback is also shutdown-gated as a backstop.
  deps.disposeAuthSessionLaneRecovery();
  deps.realtimeHost.dispose();
  await deps.stopAgentCapture();
  deps.costReconciliation.stop();
  // ISS-4903: quiesce the sync lanes BEFORE the db-host close below. `stop()`
  // only clears the lane timers — a tick already in the air (drain, sweep, or a
  // user-initiated force-archive) keeps issuing db-host reads and writes, and
  // used to land them on a disposed proxy while shutdown still reported clean.
  // Bounded by its own budget, so a wedged lane cannot hang the quit: any lane
  // still running at the deadline is returned and seeded into the phase
  // sequence below as a prior incomplete phase rather than being hidden.
  const unquiescedLanes = await quiesceDesktopSyncLanes(deps.transcriptSync);
  await deps.getAgentDashboardRuntime()?.close();
  // ISS-7247: emitted HERE, above the OTel shutdown that flushes the exporter.
  // `finishUpdateInstall()` looks like the home for `restart_initiated`, but the
  // before-quit continuation calls it AFTER this returns, on a dead runtime.
  //
  // Flush first, arm second: settling a previous attempt must not be overwritten
  // by the one this quit starts. The flush on a NON-update quit is what keeps a
  // quick manual quit after an upgrade from looking like a crash next launch.
  deps.updateTelemetry.flushPendingTerminalRecord();
  const restartTargetVersion = deps.getUpdateRestartTargetVersion();
  if (restartTargetVersion !== undefined) {
    // Resolved HERE rather than reused from the apply click: the version that
    // will actually be staged is whatever finished downloading, which a poll can
    // still have advanced since the user pressed the button.
    deps.updateTelemetry.installStarted(restartTargetVersion);
    deps.updateTelemetry.restartInitiated(restartTargetVersion);
  }
  deps.appLifecycleTelemetry.stop();
  deps.appLifecycleTelemetry.emitShutdown();
  await shutdownDesktopOtelRuntime({
    runtime: deps.appOtelRuntime,
    logWarning: deps.logWarning,
  });
  processExceptionTelemetryBridge.clearRuntime();
  deps.unregisterDisabledAgentDashboardDbIpcHandlers();
  return runShutdownSequence({
    observability: Observability,
    updateCheckTimer: deps.getUpdateCheckTimer(),
    clearUpdateCheckTimer: () => deps.clearUpdateCheckTimer(),
    cloudSocket: deps.cloudSocket,
    commandExecutor: deps.commandExecutor,
    agentMonitor: { stop: () => deps.stopAgentCapture() },
    server: deps.server,
    desktopWindow: deps.desktopWindow,
    tray: deps.tray,
    log: deps.log,
    priorIncompletePhases: unquiescedLanes,
    // Routed through the module's own helper rather than restating the
    // `Observability.desktopShutdownFailed` payload a second time — the two
    // copies were the same call, and `duringUpdate` has to be stamped from the
    // live update-apply flag in both.
    reportFailure: (failure) =>
      reportDesktopShutdownFailure(
        { trigger: "shutdown-sequence", ...failure },
        deps.isApplyingUpdate()
      ),
  });
}

/** Budget for {@link DesktopApplicationShutdownDeps.releaseSignIn}. */
export const SIGN_IN_RELEASE_BUDGET_MS = 1000;
