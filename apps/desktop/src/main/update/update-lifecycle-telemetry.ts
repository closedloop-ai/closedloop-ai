/**
 * @file update-lifecycle-telemetry.ts
 * @description ISS-7247/ISS-7225 update lifecycle reporter: the once-per-attempt
 * guarantee, the expectation that crosses the restart boundary, and the
 * boot-side reconciliation.
 *
 * The rule it enforces: nothing pre-restart may report success. A process about
 * to be replaced cannot observe which binary replaces it, so the verdict is
 * written to disk and settled by `onBoot` on the far side, where
 * `app.getVersion()` is evidence rather than prediction.
 */
import {
  UpdateEvent,
  UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import type { DesktopUpdateEventInput } from "../telemetry/app-otel-runtime-update.js";
import {
  classifyUpdateFailureReason,
  type PendingUpdateAttempt,
  resolveCurrentVersionAgeDays,
  resolveUpdateAttemptOutcome,
  type UpdateTelemetryState,
} from "./update-attempt-record.js";
import type { UpdateTelemetryStore } from "./update-telemetry-store.js";

/**
 * How long the new build must stay up before its terminal record is emitted. A
 * boot that dies inside this window never reports, so the attempt survives with
 * a higher `bootAttempts` and reads as a boot-crash. A graceful quit inside it is
 * NOT a crash — hence `flushPendingTerminalRecord`, wired into shutdown.
 */
export const UPDATE_RESTART_STABILITY_WINDOW_MS = 60_000;

/** Timer handle shape, so tests can inject without Node's full typing. */
export type UpdateTelemetryTimerHandle = { unref?: () => void };

export type DesktopUpdateLifecycleReporter = {
  /** A completed update check. `latestVersion` is what the feed offered, if anything. */
  checked: (latestVersion?: string) => void;
  /** A check that never produced an answer. `message` is classified locally. */
  checkFailed: (message: string) => void;
  available: (toVersion: string) => void;
  downloadStarted: (toVersion: string) => void;
  downloadSucceeded: (toVersion: string) => void;
  /** `message` is classified locally; the raw text never leaves this process. */
  downloadFailed: (toVersion: string | undefined, message: string) => void;
  /**
   * Offered but can never install here (read-only/translocated mount). Reported
   * rather than left as an `available` with nothing after it — a machine
   * permanently unable to upgrade is the stuck install ISS-7225 wants.
   */
  installBlocked: (toVersion: string | undefined) => void;
  installStarted: (toVersion: string | undefined) => void;
  /**
   * The point of no return: persists the from→to expectation so the next boot
   * can settle it. Emits `restart_initiated` and nothing more optimistic.
   */
  restartInitiated: (toVersion: string | undefined) => void;
  /** Boot entry point: maintains the version-age stamp and settles any pending attempt. */
  onBoot: () => void;
  /** Settle a pending attempt now, because a graceful shutdown is underway. */
  flushPendingTerminalRecord: () => void;
};

export type DesktopUpdateLifecycleReporterDeps = {
  getCurrentVersion: () => string;
  /** Returns whether the record reached the runtime; see `emitUpdateEvent`. */
  emit: (input: DesktopUpdateEventInput) => boolean;
  store: UpdateTelemetryStore;
  /**
   * Whether OTel came up this boot. A boot that cannot report must not COUNT
   * either, or a transient bootstrap failure reads as a boot-crash.
   */
  isTelemetryLive: () => boolean;
  now?: () => number;
  stabilityWindowMs?: number;
  setTimeoutFn?: (
    callback: () => void,
    delayMs: number
  ) => UpdateTelemetryTimerHandle;
  clearTimeoutFn?: (handle: UpdateTelemetryTimerHandle) => void;
};

export function createDesktopUpdateLifecycleReporter(
  deps: DesktopUpdateLifecycleReporterDeps
): DesktopUpdateLifecycleReporter {
  const now = deps.now ?? (() => Date.now());
  const stabilityWindowMs =
    deps.stabilityWindowMs ?? UPDATE_RESTART_STABILITY_WINDOW_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? defaultSetTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? defaultClearTimeout;

  /**
   * The `event:target` pairs already reported — what makes "exactly once per
   * attempt" true, an attempt being identified by the version it targets. Also
   * keeps `check` off a per-poll cadence: reported when its ANSWER changes, not
   * every five minutes.
   */
  const reported = new Set<string>();
  let pendingOutcome: DesktopUpdateEventInput | null = null;
  /**
   * The attempt as it stood BEFORE this boot's increment. An emit we WATCHED
   * fail is not a crash, so the increment is rolled back — otherwise a transient
   * exporter failure would be reported as `crash_on_boot` on the next launch. A
   * boot that dies never reaches this, which is why the increment is persisted
   * up front.
   */
  let attemptBeforeIncrement: PendingUpdateAttempt | null = null;
  let stabilityTimer: UpdateTelemetryTimerHandle | null = null;

  return {
    checked(latestVersion) {
      const state = deps.store.read();
      emitOnce({
        event: UpdateEvent.Check,
        fromVersion: deps.getCurrentVersion(),
        // Absent when the feed offered nothing, so "up to date" and "an upgrade
        // is available and untaken" stay distinguishable in the same record.
        ...(latestVersion !== undefined && latestVersion !== ""
          ? { toVersion: latestVersion }
          : {}),
        ...withVersionAge(state),
      });
    },
    checkFailed(message) {
      emitOnce({
        event: UpdateEvent.CheckFailed,
        fromVersion: deps.getCurrentVersion(),
        failureReason: classifyUpdateFailureReason(message),
      });
    },
    available(toVersion) {
      emitOnce({
        event: UpdateEvent.Available,
        fromVersion: deps.getCurrentVersion(),
        toVersion,
      });
    },
    downloadStarted(toVersion) {
      emitOnce({
        event: UpdateEvent.DownloadStarted,
        fromVersion: deps.getCurrentVersion(),
        toVersion,
      });
    },
    downloadSucceeded(toVersion) {
      emitOnce({
        event: UpdateEvent.DownloadSucceeded,
        fromVersion: deps.getCurrentVersion(),
        toVersion,
      });
    },
    downloadFailed(toVersion, message) {
      emitOnce({
        event: UpdateEvent.DownloadFailed,
        fromVersion: deps.getCurrentVersion(),
        ...(toVersion === undefined ? {} : { toVersion }),
        failureReason: classifyUpdateFailureReason(message),
      });
    },
    installBlocked(toVersion) {
      emitOnce({
        event: UpdateEvent.InstallBlocked,
        fromVersion: deps.getCurrentVersion(),
        ...(toVersion === undefined ? {} : { toVersion }),
        // Its OWN event, not download_failed/permission: no download was
        // attempted, and this machine cannot self-upgrade until a human moves
        // the app. Folding it in would bury it in the transient-EACCES
        // population that `classifyUpdateFailureReason` also maps to
        // `permission`.
        failureReason: UpdateFailureReason.Permission,
      });
    },
    installStarted(toVersion) {
      emitOnce({
        event: UpdateEvent.InstallStarted,
        fromVersion: deps.getCurrentVersion(),
        ...(toVersion === undefined ? {} : { toVersion }),
      });
    },
    restartInitiated(toVersion) {
      const fromVersion = deps.getCurrentVersion();
      if (toVersion !== undefined && toVersion !== fromVersion) {
        persistPendingAttempt({ fromVersion, toVersion, bootAttempts: 0 });
      }
      emitOnce({
        event: UpdateEvent.RestartInitiated,
        fromVersion,
        ...(toVersion === undefined ? {} : { toVersion }),
      });
    },
    onBoot() {
      const state = deps.store.read();
      const currentVersion = deps.getCurrentVersion();
      const stamped = stampInstalledVersion(state, currentVersion, now());
      if (!(state.pendingAttempt && deps.isTelemetryLive())) {
        // Leave any pending attempt exactly as found, so a telemetry-less boot
        // cannot later be mistaken for a crashed one.
        deps.store.write(stamped);
        return;
      }
      attemptBeforeIncrement = state.pendingAttempt;
      const counted: PendingUpdateAttempt = {
        ...state.pendingAttempt,
        bootAttempts: state.pendingAttempt.bootAttempts + 1,
      };
      // Persisted BEFORE emitting: a boot that dies inside the stability window
      // must leave evidence, or a crash loop looks like a clean upgrade.
      deps.store.write({ ...stamped, pendingAttempt: counted });
      pendingOutcome = resolveUpdateAttemptOutcome(counted, currentVersion);
      stabilityTimer = setTimeoutFn(() => {
        stabilityTimer = null;
        settlePendingOutcome();
      }, stabilityWindowMs);
      stabilityTimer.unref?.();
    },
    flushPendingTerminalRecord() {
      settlePendingOutcome();
    },
  };

  function emitOnce(input: DesktopUpdateEventInput): void {
    const key = `${input.event}:${input.toVersion ?? "none"}`;
    if (reported.has(key)) {
      return;
    }
    // Marked only when the record reached the runtime, so a pre-start emit does
    // not permanently suppress the transition.
    if (deps.emit(input)) {
      reported.add(key);
    }
  }

  function withVersionAge(state: UpdateTelemetryState): {
    currentVersionAgeDays?: number;
  } {
    const ageDays = resolveCurrentVersionAgeDays(
      state.installedVersionFirstSeenAtMs,
      now()
    );
    return ageDays === undefined ? {} : { currentVersionAgeDays: ageDays };
  }

  function persistPendingAttempt(attempt: PendingUpdateAttempt): void {
    deps.store.write({ ...deps.store.read(), pendingAttempt: attempt });
  }

  function settlePendingOutcome(): void {
    if (!pendingOutcome) {
      return;
    }
    const outcome = pendingOutcome;
    pendingOutcome = null;
    clearStabilityTimer();
    if (!deps.emit(outcome)) {
      // Not consumed — it stays on disk so the next boot retries rather than the
      // attempt ending silently — and the increment is undone, because we
      // OBSERVED this failure and it therefore was not a crash.
      if (attemptBeforeIncrement) {
        deps.store.write({
          ...deps.store.read(),
          pendingAttempt: attemptBeforeIncrement,
        });
        attemptBeforeIncrement = null;
      }
      return;
    }
    attemptBeforeIncrement = null;
    // Consumed: the attempt is dropped (JSON.stringify omits the undefined),
    // while the version-age stamp beside it is preserved.
    deps.store.write({ ...deps.store.read(), pendingAttempt: undefined });
  }

  function clearStabilityTimer(): void {
    if (stabilityTimer) {
      clearTimeoutFn(stabilityTimer);
      stabilityTimer = null;
    }
  }
}

/**
 * ISS-7225: re-stamped whenever the running version differs from the recorded
 * one, so the age counter measures time on the CURRENT build, not since install.
 */
function stampInstalledVersion(
  state: UpdateTelemetryState,
  currentVersion: string,
  nowMs: number
): UpdateTelemetryState {
  if (state.installedVersion === currentVersion) {
    return state;
  }
  return {
    ...state,
    installedVersion: currentVersion,
    installedVersionFirstSeenAtMs: nowMs,
  };
}

function defaultSetTimeout(
  callback: () => void,
  delayMs: number
): UpdateTelemetryTimerHandle {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: UpdateTelemetryTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
