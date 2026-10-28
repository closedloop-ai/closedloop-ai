import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { AgentMonitorRuntimeStatusKind } from "../../shared/agent-monitor-status.js";
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";
import {
  type ProcessExceptionTelemetryBridge,
  processExceptionTelemetryBridge,
} from "./process-exception-telemetry-bridge.js";
import type { RelayTelemetryTransportDiagnostics } from "./relay-telemetry-transport.js";
import { raceShutdownDeadline } from "./shutdown-deadline.js";

export const DesktopAppLifecycleEvent = {
  Start: "start",
  Heartbeat: "heartbeat",
  Shutdown: "shutdown",
} as const;

export type DesktopAppLifecycleEvent =
  (typeof DesktopAppLifecycleEvent)[keyof typeof DesktopAppLifecycleEvent];

export const DesktopAppOperatingMode = {
  SinglePlayer: "single_player",
  Multiplayer: "multiplayer",
} as const;

export type DesktopAppOperatingMode =
  (typeof DesktopAppOperatingMode)[keyof typeof DesktopAppOperatingMode];

export type DesktopOtelRuntimeWarningLogger = (
  tag: "otel",
  message: string
) => void;

export const APP_LIFECYCLE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export type DesktopAppLifecycleTelemetry = {
  start: () => void;
  stop: () => void;
  emitShutdown: () => void;
};

export type DesktopAppLifecycleTimerHandle = {
  unref?: () => void;
};

export type CreateDesktopAppLifecycleTelemetryOptions = {
  runtime: DesktopOtelRuntime;
  getOperatingMode: () => DesktopAppOperatingMode;
  /**
   * Resolves the authenticated organization id for multiplayer org attribution
   * (FEA-1996). Returns `undefined` in single-player, so lifecycle events emit
   * no org identity unless authenticated. Optional: when omitted, no org is
   * attached.
   */
  getOrganizationId?: () => string | undefined;
  /**
   * ISS-9082: the live Agent Monitor capture-runtime verdict, read at each
   * heartbeat so a runtime that fails after boot is reported by the next tick.
   * Optional: when omitted the heartbeat carries no status rather than an
   * invented one, which is what an older build already looks like downstream.
   */
  getAgentMonitorRuntimeStatus?: () => AgentMonitorRuntimeStatusKind;
  /**
   * ISS-11866 (R4): the keyless relay transport's drop and sent counters, read
   * at each heartbeat. Optional: a build with no relay transport omits them rather than
   * reporting zeros it never measured.
   */
  getTelemetryExportCounts?: () => DesktopTelemetryExportCounts;
  heartbeatIntervalMs?: number;
  setIntervalFn?: (
    callback: () => void,
    intervalMs: number
  ) => DesktopAppLifecycleTimerHandle;
  clearIntervalFn?: (handle: DesktopAppLifecycleTimerHandle) => void;
  logWarning: DesktopOtelRuntimeWarningLogger;
};

/**
 * Start the runtime for this boot and report whether it came up.
 *
 * ISS-7247's reconciler counts the boots an upgrade has survived; a boot with no
 * telemetry can report nothing, so it must not count either — otherwise a
 * transient bootstrap failure looks like a crash on the new build.
 */
export async function startDesktopOtelRuntimeForBoot({
  runtime,
  logWarning,
  exceptionBridge = processExceptionTelemetryBridge,
}: {
  runtime: DesktopOtelRuntime;
  logWarning: DesktopOtelRuntimeWarningLogger;
  /**
   * Injected like `logWarning` beside it, so this stays a function of its
   * arguments rather than of module state — the pre-init window it closes is
   * one-way, and a test driving the real singleton could not reopen it.
   */
  exceptionBridge?: ProcessExceptionTelemetryBridge;
}): Promise<boolean> {
  try {
    await runtime.start();
  } catch (error) {
    logWarning("otel", formatDesktopOtelRuntimeWarning("bootstrap", error));
    return false;
  }
  // ISS-6330: the first moment a crash captured before OTel existed has
  // somewhere to go. Composition binds the runtime long before this, but the
  // runtime discards every emit until `start()` resolves, so this — not
  // `bindRuntime` — closes the pre-init window. Skipped when start failed
  // (the `return` above): there is no started runtime to drain into, and the
  // window stays open so the records survive for a later attempt.
  exceptionBridge.markRuntimeStarted();
  return true;
}

export async function shutdownDesktopOtelRuntime({
  runtime,
  logWarning,
}: {
  runtime: DesktopOtelRuntime;
  logWarning: DesktopOtelRuntimeWarningLogger;
}): Promise<void> {
  try {
    // ISS-4585: `runtime.shutdown()` awaits the OTel SDK/exporter flush, which
    // can wedge on an unreachable collector / a stuck keepalive socket (the
    // keyless `collector_unavailable` path). This runs in `app.ts` shutdown()
    // BEFORE `runShutdownSequence`, so its per-phase bound does not cover it —
    // an unbounded flush here force-killed `desktop-dev` with SIGKILL (137).
    // Bound it with the same hard deadline so a hung exporter can never wedge
    // exit; the flush is best-effort on shutdown, so abandoning it is safe.
    await raceShutdownDeadline(runtime.shutdown());
  } catch (error) {
    logWarning("otel", formatDesktopOtelRuntimeWarning("shutdown", error));
  }
}

export function createDesktopAppLifecycleTelemetry({
  runtime,
  getOperatingMode,
  getOrganizationId,
  getAgentMonitorRuntimeStatus,
  getTelemetryExportCounts,
  heartbeatIntervalMs = APP_LIFECYCLE_HEARTBEAT_INTERVAL_MS,
  setIntervalFn = setDesktopAppLifecycleInterval,
  clearIntervalFn = clearDesktopAppLifecycleInterval,
  logWarning,
}: CreateDesktopAppLifecycleTelemetryOptions): DesktopAppLifecycleTelemetry {
  let started = false;
  let heartbeatTimer: DesktopAppLifecycleTimerHandle | null = null;
  let shutdownEmitted = false;

  return {
    start() {
      if (started) {
        return;
      }

      started = true;
      emitSafely(DesktopAppLifecycleEvent.Start);
      heartbeatTimer = setIntervalFn(() => {
        if (!heartbeatTimer) {
          return;
        }
        emitSafely(DesktopAppLifecycleEvent.Heartbeat);
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },
    stop() {
      if (!heartbeatTimer) {
        return;
      }
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    },
    emitShutdown() {
      if (shutdownEmitted) {
        return;
      }
      shutdownEmitted = true;
      emitSafely(DesktopAppLifecycleEvent.Shutdown);
    },
  };

  function emitSafely(event: DesktopAppLifecycleEvent): void {
    try {
      runtime.emitAppLifecycleEvent({
        event,
        operatingMode: getOperatingMode(),
        organizationId: getOrganizationId?.(),
        // Heartbeat only. `start` fires before the capture runtime has a
        // verdict, so its status is always `starting` — a value that says
        // nothing and reads downstream like a stuck runtime.
        agentMonitorRuntimeStatus:
          event === DesktopAppLifecycleEvent.Heartbeat
            ? getAgentMonitorRuntimeStatus?.()
            : undefined,
        // Heartbeat only: it is a LOG record, so it is never tail-sampled,
        // while start and shutdown are spans the collector samples.
        telemetryExportCounts:
          event === DesktopAppLifecycleEvent.Heartbeat
            ? getTelemetryExportCounts?.()
            : undefined,
      });
    } catch (error) {
      logWarning("otel", formatDesktopAppLifecycleWarning(event, error));
    }
  }
}

function setDesktopAppLifecycleInterval(
  callback: () => void,
  intervalMs: number
): DesktopAppLifecycleTimerHandle {
  return setInterval(callback, intervalMs);
}

function clearDesktopAppLifecycleInterval(
  handle: DesktopAppLifecycleTimerHandle
): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

export function formatDesktopOtelRuntimeWarning(
  phase: "bootstrap" | "shutdown",
  _error: unknown
): string {
  if (phase === "bootstrap") {
    return "OpenTelemetry bootstrap failed; continuing Desktop boot.";
  }
  return "OpenTelemetry shutdown failed; continuing Desktop shutdown.";
}

function formatDesktopAppLifecycleWarning(
  event: DesktopAppLifecycleEvent,
  _error: unknown
): string {
  if (event === DesktopAppLifecycleEvent.Start) {
    return "OpenTelemetry app lifecycle start emit failed; continuing Desktop boot.";
  }
  if (event === DesktopAppLifecycleEvent.Heartbeat) {
    return "OpenTelemetry app lifecycle heartbeat emit failed; continuing Desktop runtime.";
  }
  return "OpenTelemetry app lifecycle shutdown emit failed; continuing Desktop shutdown.";
}

/** The relay transport's per-cause drop counters and sent counter (ISS-11866, R4). */
export type DesktopTelemetryExportCounts = Pick<
  RelayTelemetryTransportDiagnostics,
  | "sent"
  | "droppedOversize"
  | "droppedNoSession"
  | "droppedRateLimited"
  | "droppedCollectorUnavailable"
  | "droppedInvalid"
>;

/** Project the export counters onto their contract attribute names. */
export function telemetryExportCountAttributes(
  counts: DesktopTelemetryExportCounts
): Record<string, number> {
  return {
    [TelemetryAttribute.AppTelemetryExportSentCount]: counts.sent,
    [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]:
      counts.droppedOversize,
    [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]:
      counts.droppedNoSession,
    [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]:
      counts.droppedRateLimited,
    [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]:
      counts.droppedCollectorUnavailable,
    [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]:
      counts.droppedInvalid,
  };
}
