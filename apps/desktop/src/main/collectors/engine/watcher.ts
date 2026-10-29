/**
 * @file watcher.ts
 * @description Generic live file watcher for a harness (FEA-1503; generalized
 * from the per-tool vendor `*-watcher.js`). A single factory drives every
 * harness: it debounces filesystem changes, self-heals when a watched root does
 * not exist yet (the user runs their first-ever session with a tool after the
 * app booted) or when an attached watch later fails, and runs a periodic
 * catch-up poll as an `fs.watch` miss-fallback. On every trigger it runs the
 * supplied idempotent import for the harness; the caller decides what "import"
 * means (parse changed files → importSession → emit).
 *
 * Best-effort and non-fatal: `fs.watch` is platform-quirky and a failure here
 * must never crash the main process. It must not be SILENT either (ISS-7255) —
 * the catch-up poll is 30 minutes on Desktop, so a live channel that quietly
 * dies costs half an hour of freshness with nothing in the log to say why.
 */
import { existsSync, watch } from "node:fs";

/**
 * ISS-5154 (ISP): the only members this watcher touches on an attached handle —
 * an error subscription (a platform limitation must not crash the main process)
 * and a close. `fs.FSWatcher` satisfies it structurally, so the production
 * default (`fs.watch`) is unchanged, but the `watchDirectory` TEST HOOK no
 * longer has to fabricate an entire `FSWatcher` to hand back a recorder. That
 * demand is what forced every collector suite to cast its fake through the
 * seam, which is the test asserting against a contract this module never had.
 */
export type AttachedDirectoryWatcher = {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
};

const DEBOUNCE_MS = 600;
const RETRY_MS = 4000;
const MAX_RETRY_ATTEMPTS = 75; // ~5 minutes at 4s intervals, then give up
const MAX_PENDING_EVENTS = 1000;
// fs.watch owns live freshness; this low-frequency sweep only covers missed
// platform events and avoids repeatedly scanning large local transcript trees.
const CATCHUP_POLL_MS = 60_000;

export type HarnessWatcherEvent = {
  root: string;
  filename: string;
};

export type HarnessImportControls = {
  shouldYieldToLiveEvents: () => boolean;
};

/**
 * ISS-6207 — the three honest terminal claims an import pass can make. A single
 * `completed` boolean could not tell them apart, so "the re-drive budget is
 * spent" had to borrow the spelling of "the work is finished", and the boot
 * lifecycle (which reads the same value) then fired completion over sources
 * that were never imported.
 *
 * Grow-only, and read only inside the main process (the watcher's re-drive
 * decision and the boot-import lifecycle) — it never crosses a wire.
 */
export const HarnessImportOutcome = {
  /** Every source this pass was responsible for reached a terminal outcome. */
  Completed: "completed",
  /**
   * The pass stopped with work outstanding and is STILL eligible for automatic
   * re-drive, so the watcher re-queues it immediately.
   */
  Incomplete: "incomplete",
  /**
   * The pass stopped with work outstanding and its bounded automatic re-drive
   * budget is spent. Terminal for the immediate re-drive lane ONLY: the periodic
   * catch-up poll and the next launch still re-read the sources (import is
   * idempotent), so this never latches the work off permanently. It is NOT
   * completion — no boot-import completion, maintenance, or cloud-read cutover
   * may fire on it.
   */
  RetriesExhausted: "retries_exhausted",
} as const;
export type HarnessImportOutcome =
  (typeof HarnessImportOutcome)[keyof typeof HarnessImportOutcome];

export type HarnessImportResult = {
  outcome: HarnessImportOutcome;
};

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null
) => void;

export type HarnessWatcherOptions = {
  /** Directories to recursively watch (re-evaluated on each self-heal attempt). */
  roots: () => string[];
  /** Which changed filenames trigger a re-import. */
  match: (filename: string) => boolean;
  /** Idempotent import for this harness. `null` means a historical sweep. */
  runImport: (
    events: HarnessWatcherEvent[] | null,
    controls?: HarnessImportControls
  ) => Promise<HarnessImportResult | undefined>;
  /** Whether start() should run a historical sweep before live events arrive. */
  runInitialImport?: boolean;
  /**
   * Delay the startup historical sweep while attaching live watchers
   * immediately. Used by Desktop boot to avoid monopolizing Electron before the
   * app becomes responsive.
   */
  initialImportDelayMs?: number;
  /** Missed-event sweep interval. Use null to rely on fs.watch live events only. */
  catchupPollMs?: number | null;
  /** Test hook for deterministic filesystem event delivery. */
  watchDirectory?: (
    root: string,
    listener: WatchListener
  ) => AttachedDirectoryWatcher;
  /**
   * ISS-8600: the fast re-attach loop gave up, so this harness's live delivery
   * is now catch-up-poll only — 30 minutes on Desktop. Fires ONCE per
   * exhaustion, from the give-up branch alone: an ordinary re-attach failure
   * that later recovers is a routine flap and must report nothing, or the
   * signal degrades into noise on every transient unmount.
   *
   * Narrower than exhaustion, and this half is load-bearing: only a harness
   * whose live delivery EXISTED can lose it. Every collector is registered and
   * enabled by default, so an install running one harness arms this same loop
   * for the four whose roots will never exist and runs it to exhaustion on
   * every launch. Reporting those would put four false alarms on the clock five
   * minutes after every boot, which is the noise this option exists to avoid.
   *
   * "Existed" covers two shapes, and dropping either one is a false negative:
   * a root that HELD a live watch and no longer does, and a root that EXISTS —
   * so the harness is installed — whose watch could not be armed at all,
   * because `fs.watch` threw on an inotify/descriptor limit (EMFILE, ENFILE,
   * ENOSPC) or a permission error. The second is a dead watch on an installed
   * harness just as much as the first; only a root that never existed is not.
   *
   * Injected rather than imported so the engine keeps no static edge to the
   * telemetry RUNTIME (mirrors `onIngestFailure`), and harness-agnostic: this
   * factory holds no harness identity, so the caller closes over it. Called
   * through a swallow — a throwing sink must never fail an import pass.
   */
  onWatchLost?: () => void;
  log?: (message: string) => void;
};

export type HarnessWatcher = {
  /**
   * Start boot import + live watchers. Returns a promise that resolves when the
   * first (boot) trigger() invocation settles (never rejects — trigger()
   * swallows errors internally). Callers that ignore the return value remain
   * valid (fire-and-forget).
   */
  start(): Promise<void>;
  stop(): void;
};

export function createHarnessWatcher(
  options: HarnessWatcherOptions
): HarnessWatcher {
  let started = false;
  let drainingImports: Promise<void> | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let initialImportTimer: NodeJS.Timeout | null = null;
  let initialImportImmediate: NodeJS.Immediate | null = null;
  let resolveScheduledInitialImport: (() => void) | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempts = 0;
  let historicalImportEnabled = true;
  let catchupTimer: NodeJS.Timeout | null = null;
  const watchers: AttachedDirectoryWatcher[] = [];
  const attached = new Set<string>();
  /**
   * Roots that have held a live watch at least once since `start()`. Only one
   * of these can be LOST — a root that never existed had no live delivery to
   * lose — which is what separates a dead watch from an uninstalled harness.
   */
  const everAttached = new Set<string>();
  /**
   * Roots that EXIST but whose live watch could not be armed — `fs.watch` threw
   * synchronously (EMFILE/ENFILE/ENOSPC on a descriptor or inotify limit,
   * EPERM, EACCES, ENOTDIR). The harness is installed and has no live delivery,
   * which is the same dead watch `everAttached` names and NOT the uninstalled
   * harness the report exists to stay quiet about. Cleared per root the moment
   * one arms, so a root that failed once and recovered is not still "lost".
   */
  const armFailed = new Set<string>();
  const pendingEvents: HarnessWatcherEvent[] = [];
  const pendingEventKeys = new Set<string>();
  let pendingHistoricalImport = false;

  function queueImport(events: HarnessWatcherEvent[] | null): Promise<void> {
    if (events === null) {
      pendingHistoricalImport = true;
    } else {
      for (const event of events) {
        enqueueEvent(event);
      }
    }
    return ensureDrainingImports();
  }

  function ensureDrainingImports(): Promise<void> {
    if (!drainingImports) {
      drainingImports = drainImports().finally(() => {
        drainingImports = null;
      });
    }
    return drainingImports;
  }

  async function drainImports(): Promise<void> {
    for (;;) {
      const importEvents = nextImportEvents();
      if (importEvents === undefined) {
        return;
      }
      try {
        const result = await options.runImport(
          importEvents,
          importEvents === null
            ? { shouldYieldToLiveEvents: hasPendingLiveEvents }
            : undefined
        );
        // ISS-6207: ONLY an outstanding-and-still-eligible pass is re-queued.
        // `RetriesExhausted` deliberately stops this loop — the bounded budget
        // is what keeps a source that reproducibly kills the db-host from
        // re-crashing it forever — while staying distinct from `Completed`, so
        // the boot lifecycle downstream cannot read it as a finished import.
        if (
          importEvents === null &&
          result?.outcome === HarnessImportOutcome.Incomplete
        ) {
          pendingHistoricalImport = true;
        }
      } catch {
        /* non-fatal — a partially-written file mid-turn is normal */
      }
    }
  }

  function scheduleImport(event: HarnessWatcherEvent): void {
    enqueueEvent(event);
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void ensureDrainingImports();
    }, DEBOUNCE_MS);
  }

  function attach(root: string): boolean {
    if (attached.has(root)) {
      return true;
    }
    try {
      if (!existsSync(root)) {
        return false;
      }
      const watchDirectory =
        options.watchDirectory ??
        ((watchRoot: string, listener: WatchListener) =>
          watch(watchRoot, { recursive: true }, listener));
      const w = watchDirectory(root, (_event, filename) => {
        if (!filename) {
          return;
        }
        const matchedFilename = String(filename);
        if (!options.match(matchedFilename)) {
          return;
        }
        scheduleImport({ root, filename: matchedFilename });
      });
      w.on("error", (error) => dropFailedWatch(root, w, error));
      watchers.push(w);
      attached.add(root);
      everAttached.add(root);
      armFailed.delete(root);
      options.log?.(`live watch attached to ${root}`);
      return true;
    } catch (error) {
      noteArmFailure(root, error);
      return false;
    }
  }

  /**
   * Attach every root that exists, reporting per root rather than all-or-nothing.
   * `allAttached` is the only thing that decides whether the retry loop is still
   * needed; `newlyAttached` names the roots that went from unattached to attached
   * on THIS pass, which is what a blind-window sweep is owed. Collapsing the two
   * into one boolean is the ISS-7255 defect: a permanently absent sibling (a
   * Copilot user with no `~/.copilot/session-state`) held the flag false forever
   * and so suppressed the sweep for a root that genuinely died and recovered.
   */
  function tryAttachAll(): AttachSweepResult {
    const newlyAttached: string[] = [];
    let allAttached = true;
    for (const root of options.roots()) {
      const wasAttached = attached.has(root);
      if (!attach(root)) {
        allAttached = false;
        continue;
      }
      if (!wasAttached) {
        newlyAttached.push(root);
      }
    }
    return { allAttached, newlyAttached };
  }

  function start(): Promise<void> {
    if (started) {
      return Promise.resolve();
    }
    started = true;

    // Initial catch-up (the historical import for this harness). Deferred so a
    // synchronous batch parse cannot block the first window paint. The returned
    // promise resolves when this first trigger() settles (FEA-1785).
    const runInitialImport = options.runInitialImport ?? true;
    historicalImportEnabled = runInitialImport;
    const firstImport = runInitialImport
      ? scheduleInitialImport(
          () => queueImport(null),
          options.initialImportDelayMs
        )
      : Promise.resolve();

    const catchupPollMs =
      options.catchupPollMs === undefined
        ? CATCHUP_POLL_MS
        : options.catchupPollMs;
    if (catchupPollMs != null) {
      catchupTimer = setInterval(() => {
        // The fast retry below gives up after MAX_RETRY_ATTEMPTS, but this tick
        // runs for the watcher's whole life — so it, not that loop, is what makes
        // re-attachment EVENTUAL rather than best-effort. `attach()` no-ops for a
        // root already attached, so the healthy case costs a Set lookup per root.
        tryAttachAll();
        void queueImport(null);
      }, catchupPollMs);
      catchupTimer.unref();
    }

    if (!tryAttachAll().allAttached) {
      ensureAttachRetry();
    }

    return firstImport;
  }

  function stop(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (initialImportTimer) {
      clearTimeout(initialImportTimer);
      initialImportTimer = null;
    }
    if (initialImportImmediate) {
      clearImmediate(initialImportImmediate);
      initialImportImmediate = null;
    }
    resolveScheduledInitialImport?.();
    resolveScheduledInitialImport = null;
    pendingHistoricalImport = false;
    pendingEvents.length = 0;
    pendingEventKeys.clear();
    clearAttachRetry();
    retryAttempts = 0;
    if (catchupTimer) {
      clearInterval(catchupTimer);
      catchupTimer = null;
    }
    // Drain BEFORE closing: `close()` can surface an `error`, and `dropFailedWatch`
    // splices this same array — mutating it mid-iteration would skip a handle and
    // leave a live `fs.watch` firing into a torn-down importer. Emptied first, that
    // callback finds no index and correctly no-ops.
    for (const w of watchers.splice(0, watchers.length)) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    attached.clear();
    everAttached.clear();
    armFailed.clear();
    started = false;
  }

  return { start, stop };

  function nextImportEvents(): HarnessWatcherEvent[] | null | undefined {
    if (pendingEvents.length > 0) {
      return takePendingEvents();
    }
    if (pendingHistoricalImport) {
      pendingHistoricalImport = false;
      return null;
    }
    return undefined;
  }

  function hasPendingLiveEvents(): boolean {
    return pendingEvents.length > 0;
  }

  function enqueueEvent(event: HarnessWatcherEvent): void {
    if (pendingHistoricalImport) {
      return;
    }
    const key = `${event.root}\0${event.filename}`;
    if (pendingEventKeys.has(key)) {
      return;
    }
    if (pendingEvents.length >= MAX_PENDING_EVENTS) {
      pendingEvents.length = 0;
      pendingEventKeys.clear();
      pendingHistoricalImport = true;
      options.log?.(
        `live event queue for ${event.root} exceeded ${MAX_PENDING_EVENTS} pending changes; discarded the batch for a full sweep`
      );
      return;
    }
    pendingEventKeys.add(key);
    pendingEvents.push(event);
  }

  function takePendingEvents(): HarnessWatcherEvent[] {
    const events = pendingEvents.splice(0, pendingEvents.length);
    pendingEventKeys.clear();
    return events;
  }

  /**
   * ISS-7255: a dead `fs.watch` handle used to be invisible — the error was
   * swallowed and the root stayed in `attached`, so nothing ever re-armed it and
   * live delivery was off for the rest of the process while only the catch-up
   * poll (30 minutes on Desktop) still moved data. Forget the handle so the
   * bounded retry can re-attach, and say so on the collector log.
   */
  function dropFailedWatch(
    root: string,
    failed: AttachedDirectoryWatcher,
    error: Error
  ): void {
    const index = watchers.indexOf(failed);
    if (index === -1) {
      // Already dropped (or stopped): an error storm must not re-arm per event.
      return;
    }
    watchers.splice(index, 1);
    attached.delete(root);
    try {
      failed.close();
    } catch {
      /* already torn down by the platform */
    }
    options.log?.(
      `live watch on ${root} failed (${error.message}); live events are unobserved until it re-attaches`
    );
    ensureAttachRetry();
  }

  /** Idempotent, bounded re-attach loop; a call while one runs is a no-op. */
  function ensureAttachRetry(): void {
    if (retryTimer) {
      return;
    }
    retryAttempts = 0;
    retryTimer = setInterval(() => {
      if (++retryAttempts > MAX_RETRY_ATTEMPTS) {
        clearAttachRetry();
        options.log?.(
          `gave up the fast re-attach loop after ${MAX_RETRY_ATTEMPTS} attempts; live delivery now depends on the catch-up poll re-attaching`
        );
        // ISS-8600: the terminal that previously reported only to the log —
        // reported for a harness whose live delivery existed and is gone, and
        // for nothing else. This loop is armed just as often by a root that
        // never existed (an uninstalled harness the manager registers anyway),
        // and that case has lost nothing to report.
        if (hasLostLiveWatch()) {
          reportWatchLost(options.onWatchLost);
        }
        return;
      }
      const { allAttached, newlyAttached } = tryAttachAll();
      // A root appeared, or a failed watch recovered, after boot: sweep the
      // window THAT root was blind for. Owed per root, not once every root is
      // healthy — a sibling that never existed must not cost a recovered root
      // its sweep. Skipped when this watcher runs no sweeps. A tick that
      // attached nothing new sweeps nothing, so the loop can stay armed for a
      // still-missing sibling without re-scanning the tree every RETRY_MS.
      if (newlyAttached.length > 0 && historicalImportEnabled) {
        void queueImport(null);
      }
      if (allAttached) {
        clearAttachRetry();
      }
    }, RETRY_MS);
    retryTimer.unref();
  }

  function clearAttachRetry(): void {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  /**
   * Whether this harness's live delivery existed and is currently gone: a root
   * that once held a live watch and is now unattached, or a root that exists
   * but whose watch could not be armed at all.
   *
   * False for a watcher whose only unattached roots never existed, and false
   * again once a lost root re-attaches — a still-missing sibling keeps the loop
   * armed to exhaustion, and the root that recovered must not be reported then.
   */
  function hasLostLiveWatch(): boolean {
    for (const root of everAttached) {
      if (!attached.has(root)) {
        return true;
      }
    }
    return armFailed.size > 0;
  }

  /**
   * ISS-8600: an installed harness whose watch cannot be armed must be visible
   * in BOTH channels, the way `dropFailedWatch` already is — the give-up branch
   * reads this set for the telemetry record, and the log names the errno the
   * record deliberately does not carry. Logged on the transition only: this runs
   * every RETRY_MS and then on every catch-up tick for the watcher's whole life,
   * so logging per attempt would bury the first line under its own repeats.
   *
   * The transition also RE-ARMS the bounded loop, for the same reason
   * `dropFailedWatch` does: an arm failure is a root that exists with no live
   * watch, and only that loop's give-up branch reports one. Without this, a root
   * absent at boot runs the loop to its (correctly silent) exhaustion, and the
   * arm failure that follows when the harness is installed an hour later is
   * discovered by the catch-up tick — which never re-arms anything, so nothing
   * ever reaches the give-up branch again and a dead watch on an installed
   * harness goes unreported for the life of the process. Re-arming HERE and not
   * from the tick is what keeps a root that never existed silent: `attach()`
   * returns at `existsSync` without ever reaching this function.
   */
  function noteArmFailure(root: string, error: unknown): void {
    if (armFailed.has(root)) {
      return;
    }
    armFailed.add(root);
    options.log?.(
      `live watch on ${root} could not be armed (${error instanceof Error ? error.message : String(error)}); live events are unobserved until it attaches`
    );
    ensureAttachRetry();
  }

  function scheduleInitialImport(
    run: () => Promise<void>,
    delayMs = 0
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      resolveScheduledInitialImport = resolve;
      const invoke = () => {
        initialImportTimer = null;
        initialImportImmediate = null;
        resolveScheduledInitialImport = null;
        void run().then(resolve, resolve);
      };
      if (delayMs > 0) {
        initialImportTimer = setTimeout(invoke, delayMs);
        initialImportTimer.unref();
        return;
      }
      initialImportImmediate = setImmediate(invoke);
    });
  }
}

/** Outcome of one attach pass over every configured root (ISS-7255). */
type AttachSweepResult = {
  /** Every configured root currently holds a live watch. */
  allAttached: boolean;
  /** Roots that went from unattached to attached on this pass — each is owed a sweep. */
  newlyAttached: string[];
};

/**
 * The outcome for a pass that ran to its own end: finished every source, or
 * yielded/parked with work outstanding and still eligible for re-drive. A pass
 * that ABANDONED is classified by `importOutcomeForAbandonedPass` instead — that
 * is the only path that can report a spent re-drive budget.
 */
export function harnessImportOutcomeFor(
  completed: boolean
): HarnessImportOutcome {
  return completed
    ? HarnessImportOutcome.Completed
    : HarnessImportOutcome.Incomplete;
}

/**
 * Hand the watch-lost report to its sink under the desktop exporter-boundary
 * rule (ISS-8600, the shape `reportIngestFailure` uses): a telemetry sink that
 * throws must never reach the import pipeline, so the retry loop tears down
 * whatever the sink does. An omitted sink restores the pre-ISS-8600 silence
 * with no branch at the call site.
 */
function reportWatchLost(sink: (() => void) | undefined): void {
  try {
    sink?.();
  } catch {
    // Best-effort by contract; see above.
  }
}
