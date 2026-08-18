import type { DesktopOtelRuntime } from "./app-otel-runtime.js";
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
  heartbeatIntervalMs?: number;
  setIntervalFn?: (
    callback: () => void,
    intervalMs: number
  ) => DesktopAppLifecycleTimerHandle;
  clearIntervalFn?: (handle: DesktopAppLifecycleTimerHandle) => void;
  logWarning: DesktopOtelRuntimeWarningLogger;
};

export async function startDesktopOtelRuntimeForBoot({
  runtime,
  logWarning,
}: {
  runtime: DesktopOtelRuntime;
  logWarning: DesktopOtelRuntimeWarningLogger;
}): Promise<void> {
  try {
    await runtime.start();
  } catch (error) {
    logWarning("otel", formatDesktopOtelRuntimeWarning("bootstrap", error));
  }
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
