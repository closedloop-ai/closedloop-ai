import type { ShutdownResult } from "./shutdown.js";
import type { DesktopShutdownDiagnostics } from "./telemetry-protocol.js";

export type BeforeQuitEvent = {
  preventDefault(): void;
};

export type ShutdownLifecycleApplication = {
  setQuitting(): void;
  shutdown(): Promise<ShutdownResult>;
  reportShutdownFailure(
    input: Omit<DesktopShutdownDiagnostics, "duringUpdate">
  ): void;
  /**
   * True when the current quit was initiated to apply a downloaded packaged
   * update. The before-quit handler uses this to hand the relaunch off to the
   * updater instead of force-exiting the process.
   */
  isApplyingUpdate(): boolean;
  /**
   * Hand control to the auto-updater so it installs the downloaded update and
   * relaunches into the new version. Implemented as
   * `autoUpdater.quitAndInstall(true, true)`. Called only after graceful
   * shutdown cleanup has completed.
   */
  finishUpdateInstall(): void;
};

export type BeforeQuitHandlerDeps = {
  application: ShutdownLifecycleApplication;
  exit: (code: number) => void;
  logInfo: (message: string) => void;
  logError: (message: string) => void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  hardExitMs?: number;
};

/**
 * Builds the Electron before-quit handler while keeping the shutdown ownership
 * guard testable. The first invocation owns async shutdown and every re-entry
 * observes the existing promise so update-triggered quit paths cannot run
 * cleanup twice.
 *
 * Update path: when the quit was initiated to apply a downloaded update, the
 * handler runs graceful shutdown cleanup first and then hands control to the
 * auto-updater (`finishUpdateInstall`) instead of force-exiting. The updater's
 * own `quitAndInstall` re-fires before-quit; once we have handed off, that
 * re-entry is allowed through (no `preventDefault`) so the install + relaunch
 * can proceed. Force-`app.exit()` here would terminate the process before the
 * updater's relaunch handoff, which is what left the renderer stuck on
 * "Restarting…" (FEA-2026).
 */
export function createBeforeQuitHandler(deps: BeforeQuitHandlerDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const hardExitMs = deps.hardExitMs ?? 8000;
  let quitPromise: Promise<void> | null = null;
  let handingOffToUpdater = false;

  return (event: BeforeQuitEvent): void => {
    deps.logInfo("before-quit fired");

    // After cleanup we hand the relaunch to the updater, which re-fires
    // before-quit via its own quitAndInstall. Let that quit proceed (do NOT
    // preventDefault or re-run cleanup) so the install + relaunch completes.
    if (handingOffToUpdater) {
      deps.logInfo("before-quit allowed; updater install in progress");
      return;
    }

    // Prevent Electron from proceeding until async shutdown completes.
    event.preventDefault();

    // If shutdown is already in progress, the first invocation's continuation
    // owns the exit/handoff exactly once.
    if (quitPromise) {
      deps.logInfo("before-quit ignored; shutdown already in progress");
      return;
    }

    // Signal the window to allow close events through, so it does not re-hide
    // itself and block the quit sequence.
    deps.application.setQuitting();
    const shutdownStartedAt = now();

    const hardExit = setTimeoutFn(() => {
      deps.logError("hard-exit timeout reached; forcing app.exit(1)");
      deps.application.reportShutdownFailure({
        trigger: "outer-hard-exit",
        outerHardExit: true,
        elapsedMs: now() - shutdownStartedAt,
        // `duringUpdate` is filled in by the application reporter.
      });
      deps.exit(1);
    }, hardExitMs);
    unrefTimer(hardExit);

    quitPromise = deps.application
      .shutdown()
      .then((result) => {
        if (deps.application.isApplyingUpdate()) {
          // Cleanup is done; let the updater install + relaunch. Keep the
          // hard-exit watchdog armed as a fallback so a wedged install still
          // terminates the process (autoInstallOnAppQuit then applies it).
          //
          // Set the guard BEFORE invoking the updater: quitAndInstall() can
          // re-fire before-quit synchronously, and that re-entry must be allowed
          // through (not preventDefault'd) or the relaunch hangs. Reset it if
          // the hand-off throws so a subsequent real quit can still exit.
          handingOffToUpdater = true;
          try {
            deps.application.finishUpdateInstall();
            deps.logInfo(
              "shutdown complete; handed off to updater for install + relaunch"
            );
          } catch (err: unknown) {
            handingOffToUpdater = false;
            clearTimeoutFn(hardExit);
            const message = err instanceof Error ? err.message : String(err);
            deps.logError(`update install hand-off failed: ${message}`);
            deps.application.reportShutdownFailure({
              trigger: "update-install-failed",
              result: "failed",
              phase: "finishUpdateInstall",
              elapsedMs: now() - shutdownStartedAt,
              error: message,
            });
            deps.exit(1);
          }
          return;
        }
        clearTimeoutFn(hardExit);
        deps.exit(result === "clean" ? 0 : 1);
      })
      .catch((err: unknown) => {
        clearTimeoutFn(hardExit);
        const message = err instanceof Error ? err.message : String(err);
        deps.logError(`shutdown rejected: ${message}`);
        deps.application.reportShutdownFailure({
          trigger: "shutdown-rejected",
          result: "failed",
          phase: "desktopApplication.shutdown",
          elapsedMs: now() - shutdownStartedAt,
          error: message,
        });
        deps.exit(1);
      });
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }
}
