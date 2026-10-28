/**
 * @file startup-background-scheduler.ts
 * @description FEA-2261: the runtime's startup background-work scheduler — the
 * collector-import settle signal, its fail-open bound, the renderer background
 * slot, and the serialized queue every non-critical startup task joins.
 *
 * Extracted from `agent-dashboard-design-system-runtime.ts` (ISS-9838) so that
 * file stays under the 1,000-line ceiling, and following the seam its siblings
 * already draw (`agent-dashboard-runtime-lifecycle`, `maintenance-progress-state`,
 * `post-boot-maintenance`): this module owns the SCHEDULING policy, the runtime
 * still owns what each scheduled task does.
 *
 * The reason the gate exists: the first-launch collector import (thousands of
 * transcripts) plus its post-boot data-revision rebuild and artifact-link
 * backfill is the heavy critical-path work that paints the dashboard. Each runs
 * as a synchronous chunk in the DB host, so any OTHER heavy op dispatched
 * concurrently (catalog GitHub-stats fetch, enrichment sweep, historical
 * backfill, catalog maintenance) piles onto the same child loop and starves the
 * renderer's `desktop:db:*` reads, freezing the UI/banner for ~30s.
 */
import { delay, yieldToMainLoop } from "../util/main-loop-scheduling.js";
import { STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS } from "./agent-dashboard-runtime-import-schedule.js";

export type StartupBackgroundSchedulerInput = {
  /** True once the runtime is closing; every gate short-circuits on it. */
  isClosed: () => boolean;
  log: (scope: string, message: string) => void;
  /** The renderer's idle window, when the shell wired one. */
  waitForRendererBackgroundSlot?: () => Promise<void>;
  /** First-paint gate: whichever of the two the shell supplied. */
  whenInitialBackgroundWorkAllowed?: () => Promise<void>;
  whenInitialDashboardDataServed?: () => Promise<void>;
  /** Wake consumers whose work signals were dropped while projection was held. */
  onSessionProjectionReady?: () => void;
};

export type StartupBackgroundScheduler = {
  /** Release the collector-import gate. Idempotent; safe from any settle path. */
  notifyCollectorImportSettled(): void;
  /** Record a timeout whose re-armed maintenance must settle before projection. */
  notifyCollectorImportTimedOut(): void;
  /** Release projection only when no timeout-created maintenance is owed. */
  notifyCollectorImportRetriesExhausted(): void;
  /** Release startup work and mark the session projection stable. */
  notifySessionProjectionSettled(): void;
  isSessionProjectionSettled(): boolean;
  /** Yield until the renderer has a slot for background work. */
  waitForBackgroundSlot(): Promise<void>;
  /** `delay(ms)` that also yields the renderer a slot — a cooperative delay. */
  backgroundDelay(ms: number): Promise<void>;
  /**
   * First paint, THEN the collector import, THEN the serialized queue.
   *
   * ISS-8620: the only remaining way in. The two halves this composes —
   * `enqueueStartupBackgroundTask` and `waitForInitialBackgroundWorkAllowed` —
   * are internals rather than public surface.
   */
  runAfterInitialBackgroundWorkAllowed(
    taskName: string,
    task: () => void | Promise<void>
  ): void;
};

/** Build the scheduler one runtime start owns. */
export function createStartupBackgroundScheduler(
  input: StartupBackgroundSchedulerInput
): StartupBackgroundScheduler {
  let collectorImportSettled = false;
  let sessionProjectionSettled = false;
  let timedOutMaintenanceOwed = false;
  let sessionProjectionFailOpenTimer: ReturnType<typeof setTimeout> | null =
    null;
  const collectorImportSettledResolvers = new Set<() => void>();
  const notifyCollectorImportSettled = (): void => {
    if (collectorImportSettled) {
      return;
    }
    collectorImportSettled = true;
    for (const resolve of collectorImportSettledResolvers) {
      resolve();
    }
    collectorImportSettledResolvers.clear();
  };
  const whenCollectorImportSettled = (): Promise<void> => {
    if (collectorImportSettled) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      collectorImportSettledResolvers.add(resolve);
    });
  };
  const settleSessionProjection = (failedOpen: boolean): void => {
    if (sessionProjectionSettled || input.isClosed()) {
      return;
    }
    sessionProjectionSettled = true;
    if (sessionProjectionFailOpenTimer) {
      clearTimeout(sessionProjectionFailOpenTimer);
      sessionProjectionFailOpenTimer = null;
    }
    if (failedOpen) {
      input.log(
        "agent-dashboard",
        "session projection readiness failed open after its bounded wait; waking session and invocation sync"
      );
    }
    input.onSessionProjectionReady?.();
  };
  const notifySessionProjectionSettled = (): void => {
    notifyCollectorImportSettled();
    settleSessionProjection(false);
  };
  const notifyCollectorImportTimedOut = (): void => {
    timedOutMaintenanceOwed = true;
    notifyCollectorImportSettled();
  };
  const notifyCollectorImportRetriesExhausted = (): void => {
    if (!timedOutMaintenanceOwed) {
      notifySessionProjectionSettled();
    }
  };
  sessionProjectionFailOpenTimer = setTimeout(
    () => settleSessionProjection(true),
    STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS
  );
  sessionProjectionFailOpenTimer.unref?.();
  // Fail open if the import never settles (collectors disabled, a stuck import,
  // a crashed child): these best-effort ops must not be deferred forever. Normal
  // first launches resolve the real signal well inside this window. The timer is
  // unref'd so it never holds the process open, and cleared once either side
  // wins so an early signal does not leave a dangling 5-minute timer.
  const waitForCollectorImportSettledOrTimeout = async (): Promise<void> => {
    if (collectorImportSettled) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        resolve,
        STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS
      );
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
    });
    await Promise.race([whenCollectorImportSettled(), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
  };
  const waitForBackgroundSlot = async (): Promise<void> => {
    if (input.waitForRendererBackgroundSlot) {
      await input.waitForRendererBackgroundSlot();
      return;
    }
    await yieldToMainLoop();
  };
  const backgroundDelay = async (ms: number): Promise<void> => {
    await delay(ms);
    await waitForBackgroundSlot();
  };
  let backgroundTaskTail: Promise<void> = Promise.resolve();
  const enqueueStartupBackgroundTask = (
    task: () => void | Promise<void>
  ): Promise<void> => {
    const previousTask = backgroundTaskTail.catch(() => undefined);
    const currentTask = previousTask.then(async () => {
      if (input.isClosed()) {
        return;
      }
      await waitForBackgroundSlot();
      if (input.isClosed()) {
        return;
      }
      await task();
    });
    backgroundTaskTail = currentTask.catch(() => undefined);
    return currentTask;
  };
  // First paint / dashboard-data-served (and, when wired, the renderer live-DB
  // idle window) — the fast startup gate that keeps background work off the loop
  // during the sensitive first-paint window. Bounded to a few seconds; distinct
  // from the up-to-5-minute collector-import settle gate above.
  const waitForInitialBackgroundWorkAllowed = (): Promise<void> =>
    (
      input.whenInitialBackgroundWorkAllowed ??
      input.whenInitialDashboardDataServed ??
      (() => Promise.resolve())
    )();
  const runAfterInitialBackgroundWorkAllowed = (
    taskName: string,
    task: () => void | Promise<void>
  ): void => {
    // First paint / dashboard-data-served gates first, THEN the first-launch
    // collector import + post-boot maintenance must settle (FEA-2261), THEN the
    // task joins the serialized background queue.
    waitForInitialBackgroundWorkAllowed()
      .then(() => waitForCollectorImportSettledOrTimeout())
      .then(() => enqueueStartupBackgroundTask(task))
      .catch((error: unknown) => {
        input.log(
          "agent-dashboard",
          `${taskName} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  };

  return {
    notifyCollectorImportSettled,
    notifyCollectorImportTimedOut,
    notifyCollectorImportRetriesExhausted,
    notifySessionProjectionSettled,
    isSessionProjectionSettled: () => sessionProjectionSettled,
    waitForBackgroundSlot,
    backgroundDelay,
    runAfterInitialBackgroundWorkAllowed,
  };
}
