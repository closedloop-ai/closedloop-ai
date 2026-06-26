/**
 * @file collector-manager.ts
 * @description Owns the in-process multi-harness collection layer (FEA-1503):
 * boot-time bulk import + live file watchers for all five agent CLIs (Claude,
 * Codex, Cursor, Copilot, OpenCode), writing through the injected importer into
 * the shared in-process DB. Started/stopped alongside the
 * hook listener via the `agentMonitorEnabled` toggle.
 *
 * Local import is ungated — all sessions from all five harnesses are imported
 * into the local DB regardless of the sandbox directory.
 *
 * Claude and Codex have a live hook path; their live watcher is therefore gated
 * OFF when hooks are installed (hooks own live capture — a concurrent file watcher
 * would double-count turns). Historical import can be delayed so the app can
 * start live capture without sweeping large transcript histories before the
 * window is responsive. The per-harness routing decision is owned by the single
 * source of truth
 * `getActiveCollectionMode` (FEA-1839); this manager consults it via the
 * injected `getCollectionMode` and never embeds its own hooks-installed
 * conditional.
 */
import path from "node:path";
import type { Importer } from "../agent-dashboard-db-types.js";
import { InvalidTokenCountError } from "../token-counts.js";
import { type CatchupCache, createCatchupCache } from "./catchup-cache.js";
import { createClaudeCollector } from "./claude/claude-collector.js";
import { createCodexCollector } from "./codex/codex-collector.js";
import type { CollectionMode } from "./collection-mode.js";
import { createCopilotCollector } from "./copilot/copilot-collector.js";
import { createCursorCollector } from "./cursor/cursor-collector.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-protocol.js";
import {
  ingestCachePath,
  ingestOpencodeFingerprintPath,
} from "./ingest-paths.js";
import { createOpencodeCollector } from "./opencode/opencode-collector.js";
import {
  isImportableCollectorSource,
  isImportableSourcePath,
} from "./source-admission.js";
import type {
  Harness,
  HarnessCollector,
  NormalizedSession,
  SourceImportSnapshot,
} from "./types.js";
import {
  createHarnessWatcher,
  type HarnessImportControls,
  type HarnessImportResult,
  type HarnessWatcher,
  type HarnessWatcherEvent,
} from "./watcher.js";

export type CollectorManagerOptions = {
  importer: Importer;
  /** Resolve a billing mode for a harness at session creation (FEA-1434). */
  detectBillingMode: (harness: string) => string;
  /** Durable dir for persisted catchup caches. */
  stateDir: string;
  /** Push a renderer live-update after an import batch wrote rows. */
  emit: (sessionId?: string) => void;
  /**
   * FEA-1839: the live-collection mode for a harness, resolved through the
   * single-source-of-truth `getActiveCollectionMode`. A live watcher is started
   * only for harnesses in `"watcher"` mode; `"hooks"` / `"disabled"` harnesses
   * run the idempotent boot import once with no live watcher (hooks own live
   * capture — a concurrent watcher would double-count turns).
   */
  getCollectionMode: (harness: Harness) => CollectionMode;
  /**
   * FEA-1839: invoked for each session imported via a harness's LIVE WATCHER
   * (never the boot-only branch), so the mutual-exclusivity monitor can detect a
   * watcher emitting for a session the hook handler also captured.
   */
  onWatcherEmission?: (harness: Harness, externalSessionId: string) => void;
  /** Key-free diagnostic sink. */
  log?: (message: string) => void;
  /** Injectable clock (tests pin it). */
  now?: () => string;
  /** Injectable collectors (tests pass fakes). Defaults to the five real ones. */
  collectors?: HarnessCollector[];
  /** Test hook for cooperative delays used by low-duty historical imports. */
  cooperativeDelay?: (ms: number) => Promise<void>;
  /**
   * Delay historical imports after live collection starts. `null` disables the
   * historical sweep entirely; production currently starts immediately because
   * bulk parsing runs outside Electron main and DB writes yield cooperatively.
   */
  historicalImportDelayMs?: number | null;
  /** Optional per-harness stagger added to boot historical import delays. */
  historicalImportStaggerMs?: number;
  /**
   * Missed-event sweep interval for watcher-mode harnesses. Production uses a
   * low-frequency sweep so fs.watch misses heal without repeatedly scanning
   * large transcript trees.
   */
  catchupPollMs?: number | null;
  /**
   * Parser runner for automatic historical/catch-up sweeps. Production uses an
   * Electron utility process so bulk parsing cannot monopolize the main process.
   */
  historicalParseRunner?: HistoricalParseRunner;
  /**
   * FEA-1785: Fires once after every harness's initial historical import
   * settles. Used by the data-revision rebuild to begin re-deriving stale
   * sessions.
   */
  onBootImportComplete?: () => void;
  /**
   * Self-heal hook for cache/DB divergence: returns the set of session ids
   * currently present in the database. The persistent catchup cache lives in a
   * JSON file that survives a DB reset/migration/rebuild (e.g. PGlite→SQLite),
   * so a non-batch collector whose source the cache marks "unchanged" can be
   * orphaned — the cache says "seen" but the session row is gone. Loaded ONCE
   * per import pass and consulted in `collectPendingSources`: a cache-unchanged
   * source whose derived session id is absent from this set is re-imported.
   * Undefined (or a failed load) keeps the prior skip-unchanged behavior.
   */
  listExistingSessionIds?: () => Promise<ReadonlySet<string>>;
};

export class CollectorManager {
  private readonly options: CollectorManagerOptions;
  private readonly log: (message: string) => void;
  private readonly importer: Importer;
  private readonly collectors: HarnessCollector[];
  private readonly cooperativeDelay: (ms: number) => Promise<void>;
  private readonly caches = new Map<string, CatchupCache>();
  private readonly watchers: HarnessWatcher[] = [];
  private readonly deferredImportTasks = new Set<DeferredImportTask>();
  private started = false;
  private stopped = false;
  private generation = 0;
  // FTUE ingest progress: per-harness {total, processed} for the first historical
  // import pass (source-file units ≈ sessions). Surfaced via runtime status so the
  // dashboard can show "Claude Code 612 / 1,357" while the local DB fills.
  private readonly ingestProgress = new Map<
    string,
    { total: number; processed: number }
  >();
  private readonly ingestFirstPassDone = new Set<string>();

  constructor(options: CollectorManagerOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.importer = options.importer;
    this.collectors = options.collectors ?? defaultCollectors(options.stateDir);
    this.cooperativeDelay = options.cooperativeDelay ?? delay;
    for (const collector of this.collectors) {
      if (!collector.batch) {
        this.caches.set(
          collector.key,
          createCatchupCache({
            persistPath: ingestCachePath(options.stateDir, collector.cacheName),
          })
        );
      }
    }
  }

  /** Start boot import + live watchers. Never blocks boot; never throws. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    const gen = ++this.generation;
    const firstImportPromises: Promise<void>[] = [];
    const configuredHistoricalImportDelayMs =
      this.options.historicalImportDelayMs;
    const runHistoricalImport = configuredHistoricalImportDelayMs !== null;
    const historicalImportDelayMs = configuredHistoricalImportDelayMs ?? 0;
    const historicalImportStaggerMs =
      this.options.historicalImportStaggerMs ?? 0;
    let historicalImportIndex = 0;
    for (const collector of this.collectors) {
      // FEA-1839: the SSOT decides hooks-vs-watcher for every harness uniformly.
      const watch = this.options.getCollectionMode(collector.key) === "watcher";
      const collectorHistoricalDelayMs = runHistoricalImport
        ? historicalImportDelayMs +
          historicalImportIndex++ * historicalImportStaggerMs
        : historicalImportDelayMs;
      if (watch) {
        const watcher = createHarnessWatcher({
          roots: () => collector.watchRoots(),
          match: (filename) => collector.watchMatch(filename),
          runImport: (events, controls) =>
            events === null
              ? this.runImportFor(collector, gen, true, controls)
              : this.runImportForWatcherEvents(collector, gen, events),
          runInitialImport: runHistoricalImport,
          initialImportDelayMs: collectorHistoricalDelayMs || undefined,
          catchupPollMs: runHistoricalImport
            ? this.options.catchupPollMs
            : null,
          log: this.log,
        });
        const firstImport = watcher.start();
        if (runHistoricalImport) {
          firstImportPromises.push(firstImport);
        }
        this.watchers.push(watcher);
      } else if (runHistoricalImport) {
        // Hooks (or disabled): historical import only, no live watcher. Capture
        // the import promise so onBootImportComplete waits for delayed work.
        const task = captureDeferredImport(
          () => this.runImportFor(collector, gen, false),
          collectorHistoricalDelayMs
        );
        this.deferredImportTasks.add(task);
        void task.promise.finally(() => this.deferredImportTasks.delete(task));
        firstImportPromises.push(task.promise);
      }
    }
    if (firstImportPromises.length === 0) {
      queueMicrotask(() => {
        if (!this.stopped && this.generation === gen) {
          this.options.onBootImportComplete?.();
        }
      });
      return;
    }
    void Promise.allSettled(firstImportPromises).then(() => {
      if (!this.stopped && this.generation === gen) {
        this.options.onBootImportComplete?.();
      }
    });
  }

  /** The harness collectors driven by this manager. */
  /**
   * Per-harness first-pass ingest progress for the FTUE dashboard. Harnesses
   * with no pending sources are omitted (only show a harness with ≥1 session).
   */
  getIngestProgress(): {
    byHarness: { harness: string; total: number; processed: number }[];
    total: number;
    processed: number;
  } {
    const byHarness = [...this.ingestProgress.entries()]
      .filter(([, entry]) => entry.total > 0)
      .map(([harness, entry]) => ({
        harness,
        total: entry.total,
        processed: Math.min(entry.processed, entry.total),
      }));
    return {
      byHarness,
      total: byHarness.reduce((sum, h) => sum + h.total, 0),
      processed: byHarness.reduce((sum, h) => sum + h.processed, 0),
    };
  }

  getCollectors(): readonly HarnessCollector[] {
    return this.collectors;
  }

  /** Stop watchers, halt in-flight imports, flush caches. */
  stop(): void {
    this.stopped = true;
    for (const task of this.deferredImportTasks) {
      task.cancel();
    }
    this.deferredImportTasks.clear();
    for (const watcher of this.watchers) {
      try {
        watcher.stop();
      } catch {
        /* ignore */
      }
    }
    this.watchers.length = 0;
    for (const cache of this.caches.values()) {
      cache.flush();
    }
    this.options.historicalParseRunner?.stop();
    this.started = false;
  }

  private async runImportFor(
    collector: HarnessCollector,
    generation: number,
    viaWatcher: boolean,
    controls?: HarnessImportControls
  ): Promise<HarnessImportResult> {
    if (!this.isImportActive(generation)) {
      return { completed: true };
    }
    try {
      const result = await this.importHarness(
        collector,
        generation,
        viaWatcher,
        controls
      );
      if (result.imported > 0 && this.isImportActive(generation)) {
        this.options.emit();
      }
      return { completed: result.completed };
    } catch (error) {
      this.log(
        `collector ${collector.key} import failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { completed: true };
    }
  }

  private async runImportForWatcherEvents(
    collector: HarnessCollector,
    generation: number,
    events: HarnessWatcherEvent[]
  ): Promise<HarnessImportResult> {
    if (!this.isImportActive(generation)) {
      return { completed: true };
    }
    try {
      const sources = sourcePathsForWatcherEvents(collector, events);
      const result = await this.importSources({
        collector,
        generation,
        viaWatcher: true,
        sources,
        pruneCache: false,
        lowDutyImport: false,
      });
      if (result.imported > 0 && this.isImportActive(generation)) {
        this.options.emit();
      }
      return { completed: true };
    } catch (error) {
      this.log(
        `collector ${collector.key} live import failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return { completed: true };
    }
  }

  /** Idempotent import of every current source for one harness. Returns the count written. */
  private importHarness(
    collector: HarnessCollector,
    generation: number,
    viaWatcher: boolean,
    controls?: HarnessImportControls
  ): Promise<ImportSourcesResult> {
    return this.importSources({
      collector,
      generation,
      viaWatcher,
      sources: collector
        .listSources()
        .filter((source) => isImportableCollectorSource(collector, source)),
      pruneCache: true,
      parseSource: this.parseHistoricalSource(collector),
      lowDutyImport: true,
      shouldYieldToLiveEvents: controls?.shouldYieldToLiveEvents,
    });
  }

  private async importSources({
    collector,
    generation,
    viaWatcher,
    sources,
    pruneCache,
    lowDutyImport,
    shouldYieldToLiveEvents,
    parseSource = (source) => collector.parse(source),
  }: {
    collector: HarnessCollector;
    generation: number;
    viaWatcher: boolean;
    sources: string[];
    pruneCache: boolean;
    lowDutyImport: boolean;
    shouldYieldToLiveEvents?: () => boolean;
    parseSource?: (source: string) => Promise<NormalizedSession[]>;
  }): Promise<ImportSourcesResult> {
    const cache = this.caches.get(collector.key);
    const existingSessionIds = await this.loadExistingSessionIds(
      collector,
      cache
    );
    const pendingSources = collectPendingSources(
      collector,
      cache,
      sources,
      existingSessionIds
    );
    const throttleImports =
      pendingSources.length > LARGE_IMPORT_BACKLOG_THRESHOLD;
    let imported = 0;
    // Track first-pass progress for this harness (the big historical fill).
    const trackProgress =
      lowDutyImport && !this.ingestFirstPassDone.has(collector.key);
    if (trackProgress && pendingSources.length > 0) {
      this.ingestProgress.set(collector.key, {
        total: pendingSources.length,
        processed: 0,
      });
    }

    for (const pendingSource of pendingSources) {
      if (!this.isImportActive(generation)) {
        break;
      }
      if (trackProgress) {
        const entry = this.ingestProgress.get(collector.key);
        if (entry) {
          entry.processed += 1;
        }
      }
      const sourceStartedAt = Date.now();
      const { source, stat, extraMtime, snapshot } = pendingSource;
      let sourceImported = true;

      let sessions: NormalizedSession[];
      try {
        sessions = await parseSource(source);
      } catch (error) {
        if (
          error instanceof InvalidTokenCountError &&
          !collector.batch &&
          cache
        ) {
          cache.markSeenWith(source, stat, extraMtime);
        }
        if (throttleImports) {
          await this.pauseAfterLargeBacklogSource(sourceStartedAt);
        }
        continue; // a partially-written file mid-turn is normal
      }
      if (!this.isImportActive(generation)) {
        sourceImported = false;
        break;
      }

      for (const [index, session] of sessions.entries()) {
        if (!this.isImportActive(generation)) {
          sourceImported = false;
          break;
        }
        const sessionImportStartedAt = Date.now();
        // FEA-1839: a live-watcher import for this harness session — report it to
        // the mutual-exclusivity monitor. Boot-only imports (viaWatcher=false)
        // are excluded so hooks-mode historical import never looks like a watcher.
        // The generation guard drops emissions from a watcher started in a prior
        // epoch (a stop()/start() restart resets `stopped`), so a stale import
        // cannot record into the new epoch's monitor.
        if (viaWatcher && generation === this.generation) {
          this.options.onWatcherEmission?.(collector.key, session.sessionId);
        }
        if (lowDutyImport) {
          await this.cooperativeDelay(0);
          if (!this.isImportActive(generation)) {
            sourceImported = false;
            break;
          }
        }
        const result = await this.importer.importSession(
          session,
          collector.key
        );
        if (!this.isImportActive(generation)) {
          sourceImported = false;
          break;
        }
        if (result.failed) {
          sourceImported = false;
          break;
        }
        // FEA-1791: a partial import (a tolerated record group failed to commit)
        // must not mark the source seen, so it is re-parsed next pass to retry
        // the failed group. Unlike `failed`, it does NOT halt the rest of the
        // source — the remaining sessions still import this pass.
        if (result.incomplete) {
          sourceImported = false;
        }
        if (!(result.skipped && !result.reactivated)) {
          imported++;
        }
        if (lowDutyImport && index < sessions.length - 1) {
          await this.pauseAfterHistoricalSessionImport(sessionImportStartedAt);
          if (!this.isImportActive(generation)) {
            sourceImported = false;
            break;
          }
          if (shouldYieldToLiveEvents?.()) {
            return { imported, completed: false };
          }
        }
      }

      if (
        sourceImported &&
        this.isImportActive(generation) &&
        !collector.batch &&
        cache
      ) {
        cache.markSeenWith(source, stat, extraMtime);
      }
      if (sourceImported && this.isImportActive(generation)) {
        collector.markSourceImported?.(source, snapshot);
      }

      if (throttleImports) {
        await this.pauseAfterLargeBacklogSource(sourceStartedAt);
      }
      if (lowDutyImport && shouldYieldToLiveEvents?.()) {
        return { imported, completed: false };
      }
    }

    // First full pass for this harness finished — settle its bar to 100% and
    // stop re-tracking on later catch-up passes.
    if (trackProgress && this.isImportActive(generation)) {
      this.ingestFirstPassDone.add(collector.key);
      const entry = this.ingestProgress.get(collector.key);
      if (entry) {
        entry.processed = entry.total;
      }
    }

    if (
      this.isImportActive(generation) &&
      pruneCache &&
      !collector.batch &&
      cache
    ) {
      cache.pruneTo(sources);
    }
    if (!collector.batch && cache) {
      cache.flush();
    }
    return { imported, completed: true };
  }

  private async pauseAfterLargeBacklogSource(
    sourceStartedAt: number
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.cooperativeDelay(
      computeCooperativeImportPauseMs(Date.now() - sourceStartedAt)
    );
  }

  private async pauseAfterHistoricalSessionImport(
    sessionImportStartedAt: number
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.cooperativeDelay(
      computeHistoricalSessionImportPauseMs(Date.now() - sessionImportStartedAt)
    );
  }

  private parseHistoricalSource(
    collector: HarnessCollector
  ): (source: string) => Promise<NormalizedSession[]> {
    const runner = this.options.historicalParseRunner;
    if (!runner) {
      return (source) => collector.parse(source);
    }
    return (source) => runner.parseSource(collector.key, source);
  }

  /**
   * Load the DB's current session ids ONCE per import pass, used to self-heal
   * cache/DB divergence (a cache-"unchanged" source whose row was dropped by a
   * DB reset/migration). Only relevant for non-batch collectors that have a
   * persistent catchup cache AND can derive a session id from the path
   * (`sessionIdForSource`); for everything else we skip the query so the normal
   * path pays nothing. A failed/absent loader degrades to the prior behavior
   * (skip unchanged) — never re-parse everything just because the lookup broke.
   */
  private async loadExistingSessionIds(
    collector: HarnessCollector,
    cache: CatchupCache | undefined
  ): Promise<ReadonlySet<string> | undefined> {
    if (
      collector.batch ||
      !cache ||
      !collector.sessionIdForSource ||
      !this.options.listExistingSessionIds
    ) {
      return undefined;
    }
    try {
      return await this.options.listExistingSessionIds();
    } catch (error) {
      this.log(
        `collector ${collector.key} existing-session lookup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private isImportActive(generation: number): boolean {
    return !(this.stopped || generation !== this.generation);
  }
}

/**
 * Wrap a deferred import in a promise that resolves when the import settles.
 * Used for hooks/disabled-mode historical imports so onBootImportComplete can
 * wait for them alongside watcher-based first-import promises.
 */
function captureDeferredImport(
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
      void run().then(
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

/** The five real harness collectors, wired with their durable state paths. */
function defaultCollectors(stateDir: string): HarnessCollector[] {
  return [
    createClaudeCollector(),
    createCodexCollector(),
    createCursorCollector(),
    createCopilotCollector(),
    createOpencodeCollector({
      fingerprintPath: ingestOpencodeFingerprintPath(stateDir),
    }),
  ];
}

const LARGE_IMPORT_BACKLOG_THRESHOLD = 50;
const LARGE_SOURCE_FIRST_DATA_DEFER_BYTES =
  HistoricalParseWorkerLimits.maxWorkerResponseTextBytes;
const MIN_COOPERATIVE_IMPORT_PAUSE_MS = 10;
const MAX_COOPERATIVE_IMPORT_PAUSE_MS = 100;
const MIN_HISTORICAL_SESSION_IMPORT_PAUSE_MS = 0;
// FEA-2038: the heavy import writes now run in the DB host utilityProcess, not
// on the main thread, so the backfill no longer needs the old 3x/1.5s pause to
// keep the UI alive. We keep only a setTimeout(0) yield between sessions (so the
// import loop still interleaves live watcher events) and let the per-session
// `await importSession` IPC round-trip pace throughput against child write speed.
const MAX_HISTORICAL_SESSION_IMPORT_PAUSE_MS = 50;
const HISTORICAL_SESSION_IMPORT_PAUSE_MULTIPLIER = 0;

type DeferredImportTask = {
  promise: Promise<void>;
  cancel(): void;
};

type ImportSourcesResult = {
  imported: number;
  completed: boolean;
};

type PendingSource = {
  source: string;
  stat: ReturnType<CatchupCache["isUnchanged"]>["stat"];
  extraMtime: number | null;
  snapshot?: SourceImportSnapshot;
};

function collectPendingSources(
  collector: HarnessCollector,
  cache: CatchupCache | undefined,
  sources: string[],
  existingSessionIds?: ReadonlySet<string>
): PendingSource[] {
  const pendingSources: PendingSource[] = [];
  for (const source of sources) {
    const extraMtime = collector.extraMtime
      ? collector.extraMtime(source)
      : null;
    let stat: PendingSource["stat"] = null;
    if (!collector.batch && cache) {
      const status = cache.isUnchanged(source, extraMtime);
      if (
        status.unchanged &&
        !isOrphanedFromDb(collector, source, existingSessionIds)
      ) {
        continue;
      }
      stat = status.stat;
    }
    const snapshot = collector.sourceFingerprint
      ? { fingerprint: collector.sourceFingerprint(source) }
      : undefined;
    pendingSources.push({ source, stat, extraMtime, snapshot });
  }
  pendingSources.sort(
    (a, b) =>
      pendingSourceLargeDeferRank(a) - pendingSourceLargeDeferRank(b) ||
      (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0)
  );
  return pendingSources;
}

/**
 * Self-heal cache/DB divergence: a source the persistent catchup cache marks
 * "unchanged" but whose derived session row is GONE from the current database
 * must be re-imported, not skipped. This happens after a DB reset/migration/
 * rebuild (e.g. PGlite→SQLite): the JSON ingest cache persists across that
 * reset INDEPENDENTLY of the DB, so non-batch collectors (codex, claude) would
 * otherwise stay orphaned forever — cache says "seen", DB has no row.
 *
 * Only collectors that can derive the session id from the path alone (no I/O,
 * `sessionIdForSource`, FEA-1785) participate. When the id can't be derived
 * without parsing (returns null) we keep the cheap "skip unchanged" behavior so
 * steady-state boots never re-parse every transcript. When the id IS derivable
 * and IS present in `existingSessionIds`, the source is still skipped — normal
 * steady state is unchanged.
 */
function isOrphanedFromDb(
  collector: HarnessCollector,
  source: string,
  existingSessionIds: ReadonlySet<string> | undefined
): boolean {
  if (!existingSessionIds) {
    return false;
  }
  const sessionId = collector.sessionIdForSource?.(source) ?? null;
  if (sessionId === null) {
    return false;
  }
  return !existingSessionIds.has(sessionId);
}

function pendingSourceLargeDeferRank(source: PendingSource): number {
  const size = source.stat?.size ?? 0;
  return size > LARGE_SOURCE_FIRST_DATA_DEFER_BYTES ? 1 : 0;
}

/**
 * Convert watcher events into importable source paths for a collector.
 * Mapped sources are constrained to regular files under the watched root so an
 * event-scoped import cannot parse arbitrary local paths.
 */
export function sourcePathsForWatcherEvents(
  collector: HarnessCollector,
  events: HarnessWatcherEvent[]
): string[] {
  const sources = new Set<string>();
  for (const event of events) {
    const mapped = collector.sourcePathsForWatchEvent?.(
      event.root,
      event.filename
    ) ?? [
      path.isAbsolute(event.filename)
        ? event.filename
        : path.join(event.root, event.filename),
    ];
    for (const source of mapped) {
      const resolvedSource = path.resolve(source);
      if (isImportableSourcePath(resolvedSource, [event.root])) {
        sources.add(resolvedSource);
      }
    }
  }
  return [...sources];
}

function computeCooperativeImportPauseMs(sourceDurationMs: number): number {
  return Math.min(
    MAX_COOPERATIVE_IMPORT_PAUSE_MS,
    Math.max(MIN_COOPERATIVE_IMPORT_PAUSE_MS, sourceDurationMs)
  );
}

function computeHistoricalSessionImportPauseMs(
  sessionImportDurationMs: number
): number {
  return Math.min(
    MAX_HISTORICAL_SESSION_IMPORT_PAUSE_MS,
    Math.max(
      MIN_HISTORICAL_SESSION_IMPORT_PAUSE_MS,
      sessionImportDurationMs * HISTORICAL_SESSION_IMPORT_PAUSE_MULTIPLIER
    )
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
