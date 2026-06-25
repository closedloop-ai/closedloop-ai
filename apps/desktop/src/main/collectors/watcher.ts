/**
 * @file watcher.ts
 * @description Generic live file watcher for a harness (FEA-1503; generalized
 * from the per-tool vendor `*-watcher.js`). A single factory drives every
 * harness: it debounces filesystem changes, self-heals when a watched root does
 * not exist yet (the user runs their first-ever session with a tool after the
 * app booted), and runs a periodic catch-up poll as an `fs.watch` miss-fallback.
 * On every trigger it runs the supplied idempotent import for the harness; the
 * caller decides what "import" means (parse changed files → importSession → emit).
 *
 * Best-effort and non-fatal: `fs.watch` is platform-quirky and a failure here
 * must never crash the main process — the catch-up poll still keeps the dashboard
 * current.
 */
import { existsSync, type FSWatcher, watch } from "node:fs";

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

export type HarnessImportResult = {
  completed: boolean;
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
  watchDirectory?: (root: string, listener: WatchListener) => FSWatcher;
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
  let catchupTimer: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const attached = new Set<string>();
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
        if (importEvents === null && result?.completed === false) {
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
      w.on("error", () => {
        /* platform limitation — the catch-up poll still covers changes */
      });
      watchers.push(w);
      attached.add(root);
      return true;
    } catch {
      return false;
    }
  }

  /** Attach every root that exists; returns true once all roots are attached. */
  function tryAttachAll(): boolean {
    let all = true;
    for (const root of options.roots()) {
      if (!attach(root)) {
        all = false;
      }
    }
    return all;
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
      catchupTimer = setInterval(() => void queueImport(null), catchupPollMs);
      catchupTimer.unref();
    }

    if (tryAttachAll()) {
      return firstImport;
    }

    let retries = 0;
    retryTimer = setInterval(() => {
      if (++retries > MAX_RETRY_ATTEMPTS) {
        if (retryTimer) {
          clearInterval(retryTimer);
        }
        retryTimer = null;
        return;
      }
      if (tryAttachAll()) {
        if (retryTimer) {
          clearInterval(retryTimer);
        }
        retryTimer = null;
        // A root just appeared after boot. Avoid a full historical sweep unless
        // this watcher is configured to run startup imports.
        if (runInitialImport) {
          void queueImport(null);
        }
      }
    }, RETRY_MS);
    retryTimer.unref();

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
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    if (catchupTimer) {
      clearInterval(catchupTimer);
      catchupTimer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
    attached.clear();
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
