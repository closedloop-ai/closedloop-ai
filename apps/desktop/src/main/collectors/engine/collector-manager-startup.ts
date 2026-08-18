/**
 * @file collector-manager-startup.ts
 * @description Per-harness start-up scheduling for `CollectorManager` —
 * the decision, taken once per `start()` epoch, of what each collector runs:
 * nothing (its per-tool toggle is off), a live file watcher (FEA-1839
 * `"watcher"` mode) whose own first sweep is the boot import, or a deferred
 * boot-only import (`"hooks"` / `"disabled"` mode). Owns the staggered
 * historical-import delay and the deferred-import task wrapper that lets
 * `onBootImportComplete` wait on a delayed import.
 *
 * Extracted from `collector-manager.ts` so that grandfathered file stays
 * shrink-only. The manager still owns the epoch (`generation`), the boot-import
 * watchdog, and the import passes themselves; this module only builds the plan
 * and hands back the promises/handles the manager must track for `stop()`.
 */
import type { Harness, HarnessCollector } from "../types.js";
import type { CollectionMode } from "./collection-mode.js";
import {
  createHarnessWatcher,
  type HarnessImportControls,
  type HarnessImportResult,
  type HarnessWatcher,
  type HarnessWatcherEvent,
  type HarnessWatcherOptions,
} from "./watcher.js";

export type DeferredImportTask = {
  promise: Promise<void>;
  cancel(): void;
};

/** What one `start()` epoch scheduled, for the manager to track and later stop. */
export type HarnessStartupPlan = {
  /** Resolves once every scheduled first import settles (boot-import gate). */
  firstImportPromises: Promise<void>[];
  watchers: HarnessWatcher[];
  deferredTasks: DeferredImportTask[];
};

export type HarnessStartupInput = {
  collectors: readonly HarnessCollector[];
  isCollectorEnabled?: ((harness: Harness) => boolean) | undefined;
  getCollectionMode: (harness: Harness) => CollectionMode;
  historicalImportDelayMs?: number | null | undefined;
  historicalImportStaggerMs?: number | undefined;
  catchupPollMs?: number | null | undefined;
  watchDirectory?: HarnessWatcherOptions["watchDirectory"] | undefined;
  /** Full-sweep import for one harness (a watcher catch-up, or the boot pass). */
  runFullImport: (
    collector: HarnessCollector,
    viaWatcher: boolean,
    controls?: HarnessImportControls
  ) => Promise<HarnessImportResult>;
  /** Targeted import for a batch of live watcher events. */
  runWatcherEventImport: (
    collector: HarnessCollector,
    events: HarnessWatcherEvent[]
  ) => Promise<HarnessImportResult>;
  log: (message: string) => void;
};

/**
 * Wrap a deferred import in a promise that resolves when the import settles.
 * Used for hooks/disabled-mode historical imports so onBootImportComplete can
 * wait for them alongside watcher-based first-import promises.
 */
export function captureDeferredImport(
  run: () => Promise<unknown>,
  delayMs: number
): DeferredImportTask {
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  let immediate: NodeJS.Immediate | null = null;
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    const invoke = () => {
      timeout = null;
      immediate = null;
      settled = true;
      // Settle the same way whichever way the import ends: the boot-import gate
      // waits for the import to FINISH, not to succeed.
      run().then(
        () => resolve(),
        () => resolve()
      );
    };
    if (delayMs > 0) {
      timeout = setTimeout(invoke, delayMs);
      timeout.unref();
      return;
    }
    immediate = setImmediate(invoke);
  });

  return {
    promise,
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (immediate) {
        clearImmediate(immediate);
        immediate = null;
      }
      resolvePromise();
    },
  };
}

/**
 * Decide, for every collector, whether this epoch runs a live watcher, a
 * deferred boot-only import, or nothing at all — and schedule it. Returns the
 * handles the caller must retain: the first-import promises to gate boot
 * completion on, plus the watchers and deferred tasks to tear down in `stop()`.
 */
export function scheduleHarnessStartup(
  input: HarnessStartupInput
): HarnessStartupPlan {
  const plan: HarnessStartupPlan = {
    firstImportPromises: [],
    watchers: [],
    deferredTasks: [],
  };
  const configuredHistoricalImportDelayMs = input.historicalImportDelayMs;
  const runHistoricalImport = configuredHistoricalImportDelayMs !== null;
  const historicalImportDelayMs = configuredHistoricalImportDelayMs ?? 0;
  const historicalImportStaggerMs = input.historicalImportStaggerMs ?? 0;
  let historicalImportIndex = 0;
  for (const collector of input.collectors) {
    // FEA-3741 (slice 1): a per-tool collector toggle turned OFF skips the
    // harness entirely — no live watcher AND no historical import — so its
    // tool-home walk (~/.claude, ~/.cursor, Copilot workspace storage) never
    // runs and can't incidentally touch a TCC-protected folder. This is a
    // separate gate from `getCollectionMode` on purpose: golden mode forces
    // `getCollectionMode` to "disabled" but STILL needs the one-shot corpus
    // import to run, so the "disabled" mode alone must not skip the import.
    // `isCollectorEnabled` defaults to enabled (omitted → always-on posture),
    // and golden mode leaves it at the default, so golden import is untouched.
    if (input.isCollectorEnabled?.(collector.key) === false) {
      continue;
    }
    // FEA-1839: the SSOT decides hooks-vs-watcher for every harness uniformly.
    const watch = input.getCollectionMode(collector.key) === "watcher";
    const collectorHistoricalDelayMs = runHistoricalImport
      ? historicalImportDelayMs +
        historicalImportIndex++ * historicalImportStaggerMs
      : historicalImportDelayMs;
    if (watch) {
      const watcher = startCollectorWatcher(
        input,
        collector,
        runHistoricalImport,
        collectorHistoricalDelayMs
      );
      const firstImport = watcher.start();
      if (runHistoricalImport) {
        plan.firstImportPromises.push(firstImport);
      }
      plan.watchers.push(watcher);
    } else if (runHistoricalImport) {
      // Hooks (or disabled): historical import only, no live watcher. Capture
      // the import promise so onBootImportComplete waits for delayed work.
      const task = captureDeferredImport(
        () => input.runFullImport(collector, false),
        collectorHistoricalDelayMs
      );
      plan.deferredTasks.push(task);
      plan.firstImportPromises.push(task.promise);
    }
  }
  return plan;
}

/**
 * Build (but do not start) the live file watcher for one `"watcher"`-mode
 * harness. `runImport(null, …)` is the watcher's own full sweep — its initial
 * import and its periodic missed-event catch-up — while a non-null event batch
 * takes the targeted path.
 */
function startCollectorWatcher(
  input: HarnessStartupInput,
  collector: HarnessCollector,
  runHistoricalImport: boolean,
  historicalDelayMs: number
): HarnessWatcher {
  return createHarnessWatcher({
    roots: () => collector.watchRoots(),
    match: (filename) => collector.watchMatch(filename),
    runImport: (events, controls) =>
      events === null
        ? input.runFullImport(collector, true, controls)
        : input.runWatcherEventImport(collector, events),
    runInitialImport: runHistoricalImport,
    initialImportDelayMs: historicalDelayMs || undefined,
    catchupPollMs: runHistoricalImport ? input.catchupPollMs : null,
    ...(input.watchDirectory ? { watchDirectory: input.watchDirectory } : {}),
    log: input.log,
  });
}
