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
 * Claude is the only harness with a live hook path; its live watcher is therefore
 * gated OFF when hooks are installed (hooks own live capture — a concurrent file
 * watcher would double-count turns). Every other harness (Codex included — Codex
 * hooks were removed, PRD-431) always runs its watcher. Historical import can be
 * delayed so the app can
 * start live capture without sweeping large transcript histories before the
 * window is responsive. The per-harness routing decision is owned by the single
 * source of truth
 * `getActiveCollectionMode` (FEA-1839); this manager consults it via the
 * injected `getCollectionMode` and never embeds its own hooks-installed
 * conditional.
 */
import { stat as statAsync } from "node:fs/promises";
import path from "node:path";
import type { Importer } from "../../agent-dashboard-db-types.js";
import { InvalidTokenCountError } from "../../token-counts.js";
import { createClaudeCollector } from "../claude/claude-collector.js";
import { createCodexCollector } from "../codex/codex-collector.js";
import { createCopilotCollector } from "../copilot/copilot-collector.js";
import { createCursorCollector } from "../cursor/cursor-collector.js";
import { createOpencodeCollector } from "../opencode/opencode-collector.js";
import {
  type Harness,
  type HarnessCollector,
  type NormalizedSession,
  narrowHarness,
  type SourceImportSnapshot,
} from "../types.js";
import { type CatchupCache, createCatchupCache } from "./catchup-cache.js";
import type { CollectionMode } from "./collection-mode.js";
import { yieldToEventLoop } from "./cooperative-yield.js";
import type { HistoricalParseRunner } from "./historical-parse-runner.js";
import { HistoricalParseWorkerLimits } from "./historical-parse-worker-protocol.js";
import {
  ingestCachePath,
  ingestCodexLinkageCachePath,
  ingestOpencodeFingerprintPath,
} from "./ingest-paths.js";
import {
  isImportableCollectorSource,
  isImportableSourcePath,
} from "./source-admission.js";
import {
  createHarnessWatcher,
  type HarnessImportControls,
  type HarnessImportResult,
  type HarnessWatcher,
  type HarnessWatcherEvent,
} from "./watcher.js";

type CollectorManagerOptions = {
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
  // Yield to the renderer once before the first-pass source scan so the import
  // banner can render (and start its off-main-thread shimmer) before the
  // synchronous scan blocks the main thread. Defaults to a no-op.
  waitForRendererBackgroundSlot?: () => Promise<void>;
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
  /**
   * Deletes a local session and all derived child rows. Called only when a
   * collector positively classifies an empty parse as an import artifact that
   * current semantics fold under another source.
   */
  deleteSessionRow?: (sessionId: string) => Promise<void>;
};

export class CollectorManager {
  private readonly options: CollectorManagerOptions;
  private readonly log: (message: string) => void;
  private readonly importer: Importer;
  private readonly collectors: HarnessCollector[];
  private readonly cooperativeDelay: (ms: number) => Promise<void>;
  private readonly waitForRendererBackgroundSlot: () => Promise<void>;
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
  // Whether the boot historical import has fully finished for every harness.
  // The per-harness passes are staggered, so aggregate `processed === total`
  // is momentarily true between one harness completing and the next registering
  // its sources; the banner uses this flag (not that aggregate) to know the
  // whole import is done, so it never collapses early and miss a later harness.
  private bootImportComplete = false;
  // Console-observability for the first-pass backfill (the ingestProgress map
  // above feeds the dashboard card; these surface the same progress in the main
  // log so a terminal can tell "importing" apart from "hung"). Keyed by harness:
  // `ingestStartedAt` is the first-pass start (set once; gates the announce /
  // completion lines and yields a correct duration across yield/resume), and
  // `ingestProgressLoggedAt` throttles the periodic progress line.
  private readonly ingestStartedAt = new Map<string, number>();
  private readonly ingestProgressLoggedAt = new Map<string, number>();
  // Pause/resume for the long first-launch backfill (in-memory, so it resets on
  // app restart and is unaffected by window focus). While paused, the import
  // loop awaits `pauseGate`; resume() or stop() resolves it. Only the historical
  // (lowDuty) pass is pausable; live-watcher imports are never paused.
  private importPaused = false;
  private pauseGate: { promise: Promise<void>; resolve: () => void } | null =
    null;
  // Harnesses whose first-pass import has begun but whose source scan
  // (collectPendingSources, a synchronous stat per file) has not yet produced a
  // total. Surfaced so the import banner can show an indeterminate "preparing"
  // state BEFORE the scan blocks the main thread, rather than only appearing once
  // the total is known (after the freeze).
  private readonly ingestPreparing = new Set<string>();

  constructor(options: CollectorManagerOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.importer = options.importer;
    this.collectors = options.collectors ?? defaultCollectors(options.stateDir);
    this.cooperativeDelay = options.cooperativeDelay ?? delay;
    this.waitForRendererBackgroundSlot =
      options.waitForRendererBackgroundSlot ?? (() => Promise.resolve());
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
    this.bootImportComplete = false;
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
          this.bootImportComplete = true;
          this.options.onBootImportComplete?.();
        }
      });
      return;
    }
    void Promise.allSettled(firstImportPromises).then(() => {
      if (!this.stopped && this.generation === gen) {
        this.bootImportComplete = true;
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
    preparing: boolean;
    complete: boolean;
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
      // A first-pass import has begun but not yet produced a total (the source
      // scan is running); the banner shows an indeterminate state for this.
      preparing: this.ingestPreparing.size > 0,
      // Every harness's boot import has finished. Distinct from aggregate
      // `processed === total`, which is briefly true between staggered passes.
      complete: this.bootImportComplete,
    };
  }

  getCollectors(): readonly HarnessCollector[] {
    return this.collectors;
  }

  /** Pause the first-launch backfill (live-watcher imports are unaffected). */
  pauseImport(): void {
    this.importPaused = true;
  }

  /** Resume a paused backfill and unblock the import loop. */
  resumeImport(): void {
    this.importPaused = false;
    this.pauseGate?.resolve();
    this.pauseGate = null;
  }

  isImportPaused(): boolean {
    return this.importPaused;
  }

  /** Resolves immediately unless the backfill is paused, in which case it awaits
   *  the next resume() (or stop(), which also resolves the gate). */
  private waitWhilePaused(): Promise<void> {
    if (!this.importPaused) {
      return Promise.resolve();
    }
    if (!this.pauseGate) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.pauseGate = { promise, resolve };
    }
    return this.pauseGate.promise;
  }

  /** Stop watchers, halt in-flight imports, flush caches. */
  stop(): void {
    this.stopped = true;
    // Unblock a paused import so its loop can observe `stopped` and exit.
    this.resumeImport();
    this.ingestPreparing.clear();
    // Drop the first-pass console-log bookkeeping so a stop()/start() restart
    // re-announces from a clean slate instead of reusing a prior epoch's start
    // time or last-logged-at (which would skew the duration and throttle).
    this.ingestStartedAt.clear();
    this.ingestProgressLoggedAt.clear();
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
      const result = await this.importSources({
        collector,
        generation,
        viaWatcher: true,
        resolveSources: () => sourcePathsForWatcherEvents(collector, events),
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
      resolveSources: () =>
        collector
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
    resolveSources,
    pruneCache,
    lowDutyImport,
    shouldYieldToLiveEvents,
    parseSource = (source) => collector.parse(source),
  }: {
    collector: HarnessCollector;
    generation: number;
    viaWatcher: boolean;
    resolveSources: () => string[];
    pruneCache: boolean;
    lowDutyImport: boolean;
    shouldYieldToLiveEvents?: () => boolean;
    parseSource?: (source: string) => Promise<NormalizedSession[]>;
  }): Promise<ImportSourcesResult> {
    const cache = this.caches.get(collector.key);
    // Narrow the discriminated union once so the loop below can reach for
    // file-only members (sessionIdForSource/isBurstArtifactSource) or batch-only
    // members (markSourceImported) without re-narrowing at each interleaved use.
    // Each reference is `undefined` for the other kind, preserving the prior
    // optional-chaining no-op behavior.
    const { fileCollector, batchCollector } = narrowHarness(collector);
    // First-pass historical import: flag "preparing" and yield BEFORE any
    // synchronous source scan blocks the main thread, so the import banner can
    // render and start its off-main-thread shimmer before the freeze rather than
    // only appearing once the total is known afterward. Gated on
    // `!ingestProgress.has` so re-entries don't repeat.
    if (lowDutyImport && !this.ingestProgress.has(collector.key)) {
      this.ingestPreparing.add(collector.key);
      await this.waitForRendererBackgroundSlot();
      if (!this.isImportActive(generation)) {
        this.ingestPreparing.delete(collector.key);
        return { imported: 0, completed: false };
      }
    }
    // Track first-pass progress for this harness (the big historical fill).
    const trackProgress =
      lowDutyImport && !this.ingestFirstPassDone.has(collector.key);
    // The scan (source enumeration, existing-id load, pending computation) runs
    // inside try/finally so the "preparing" marker is ALWAYS cleared once the
    // total is known or the scan fails — a throw here must not leave the banner
    // stuck showing "preparing" forever.
    let sources: string[];
    let pendingSources: Awaited<ReturnType<typeof collectPendingSources>>;
    try {
      // Enumerate sources only AFTER the preparing yield. `listSources()` does a
      // synchronous recursive directory walk that, for a large local history, is
      // itself a main-thread freeze; resolving it lazily here (rather than at the
      // call site) keeps it from running before the banner can paint.
      sources = resolveSources();
      const existingSessionIds = await this.loadExistingSessionIds(
        collector,
        cache
      );
      const foldedChildSessionIds = new Set<string>();
      pendingSources = await collectPendingSources(
        collector,
        cache,
        sources,
        existingSessionIds,
        foldedChildSessionIds
      );
      // FEA-2264: collectPendingSources now yields cooperatively, so this
      // generation may have been stopped or superseded by a restart while the
      // scan was suspended. Bail before mutating shared state (folded-child
      // deletes, ingestProgress, the backfill log) so a stale generation cannot
      // clobber the live one's banner/progress.
      if (!this.isImportActive(generation)) {
        return { imported: 0, completed: false };
      }
      for (const sessionId of foldedChildSessionIds) {
        if (!this.isImportActive(generation)) {
          break;
        }
        if (this.options.deleteSessionRow) {
          try {
            await this.options.deleteSessionRow(sessionId);
          } catch (error) {
            this.log(
              `collector ${collector.key} folded-child cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      if (trackProgress && pendingSources.length > 0) {
        this.ingestProgress.set(collector.key, {
          total: pendingSources.length,
          processed: 0,
        });
        // Announce a substantial first-pass backfill ONCE (set-if-absent so a
        // yield/resume does not re-announce), so the main log shows the import
        // started and at what scale. Small catch-ups stay quiet.
        if (
          pendingSources.length >= INGEST_LOG_MIN_SOURCES &&
          !this.ingestStartedAt.has(collector.key)
        ) {
          const startedAt = Date.now();
          this.ingestStartedAt.set(collector.key, startedAt);
          this.ingestProgressLoggedAt.set(collector.key, startedAt);
          this.log(
            `session backfill [${collector.key}]: importing ${pendingSources.length} source file(s); first launch can take a while`
          );
        }
      }
    } finally {
      // The scan finished (the total is now set above, or there is nothing to
      // import) or it threw — either way, leave the indeterminate "preparing"
      // state so it can never stay stuck on.
      this.ingestPreparing.delete(collector.key);
    }

    const throttleImports =
      pendingSources.length > LARGE_IMPORT_BACKLOG_THRESHOLD;
    let imported = 0;
    // Persist the catchup cache incrementally during the pass (the throttled
    // flush in the loop below): a kill mid-pass otherwise discards everything
    // marked seen so far, re-processing every source on the next launch.
    let lastCacheFlushAt = Date.now();
    // Profiling: accumulate where the per-source wall time goes so the throttled
    // progress line can report the average parse vs import cost, telling whether
    // the import is paced by parsing rollouts or by the db-host writes.
    let parseMsTotal = 0;
    let importMsTotal = 0;

    for (const pendingSource of pendingSources) {
      if (!this.isImportActive(generation)) {
        break;
      }
      // Cooperative pause point: the user can pause the long first-launch
      // backfill from the import banner. Only the historical (lowDuty) pass is
      // pausable; live-watcher imports continue. Re-check active after resuming
      // since stop() may have fired while paused.
      if (lowDutyImport && this.importPaused) {
        await this.waitWhilePaused();
        if (!this.isImportActive(generation)) {
          break;
        }
      }
      if (trackProgress) {
        const entry = this.ingestProgress.get(collector.key);
        if (entry) {
          entry.processed += 1;
          // Time-throttled progress line (scale-independent: one update at most
          // every INGEST_LOG_INTERVAL_MS regardless of backlog size). Gated on
          // an announced backfill so small catch-ups never log.
          if (this.ingestStartedAt.has(collector.key)) {
            const now = Date.now();
            const lastLoggedAt =
              this.ingestProgressLoggedAt.get(collector.key) ?? 0;
            if (now - lastLoggedAt >= INGEST_LOG_INTERVAL_MS) {
              this.ingestProgressLoggedAt.set(collector.key, now);
              const parseAvgMs =
                entry.processed > 0
                  ? Math.round(parseMsTotal / entry.processed)
                  : 0;
              const importAvgMs =
                entry.processed > 0
                  ? Math.round(importMsTotal / entry.processed)
                  : 0;
              this.log(
                `session backfill [${collector.key}]: ${entry.processed}/${entry.total} source file(s) (avg/source: parse ${parseAvgMs}ms, import ${importAvgMs}ms)`
              );
            }
          }
        }
      }
      const sourceStartedAt = Date.now();
      const { source, stat, extraMtime, snapshot } = pendingSource;
      let sourceImported = true;

      let sessions: NormalizedSession[];
      const parseStartedAt = Date.now();
      try {
        sessions = await parseSource(source);
      } catch (error) {
        parseMsTotal += Date.now() - parseStartedAt;
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
      parseMsTotal += Date.now() - parseStartedAt;
      if (!this.isImportActive(generation)) {
        sourceImported = false;
        break;
      }

      if (
        sessions.length === 0 &&
        fileCollector?.isBurstArtifactSource?.(source) &&
        fileCollector.sessionIdForSource &&
        this.options.deleteSessionRow
      ) {
        const sessionId = fileCollector.sessionIdForSource(source);
        if (sessionId) {
          await this.options.deleteSessionRow(sessionId);
        }
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
        const importStartedAt = Date.now();
        const result = await this.importer.importSession(
          session,
          collector.key
        );
        importMsTotal += Date.now() - importStartedAt;
        if (!this.isImportActive(generation)) {
          sourceImported = false;
          break;
        }
        if (result.failed) {
          sourceImported = false;
          break;
        }
        // A partial import (a tolerated record group failed to commit) must not
        // mark the source seen, so it is re-parsed next pass to retry the failed
        // group. Unlike `failed`, it does NOT halt the rest of the source — the
        // remaining sessions still import this pass.
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
        // Flush the marked-seen set to disk on a throttle so a long first-launch
        // backfill resumes after a kill/restart instead of restarting from zero.
        // The whole-map write runs at most once per interval; the end-of-pass
        // flush below still runs.
        const flushNow = Date.now();
        if (flushNow - lastCacheFlushAt >= CACHE_FLUSH_INTERVAL_MS) {
          lastCacheFlushAt = flushNow;
          cache.flush();
        }
      }
      if (sourceImported && this.isImportActive(generation)) {
        batchCollector?.markSourceImported?.(source, snapshot);
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
      // Close out an announced backfill with a duration so the log shows it
      // finished (and how long it took) rather than just going quiet. Duration
      // is correct even across yield/resume because the start time is set once.
      const startedAt = this.ingestStartedAt.get(collector.key);
      if (startedAt !== undefined) {
        const seconds = Math.max(
          1,
          Math.round((Date.now() - startedAt) / 1000)
        );
        this.log(
          `session backfill [${collector.key}] first pass complete: ${entry?.total ?? 0} source file(s) in ${seconds}s`
        );
        this.ingestStartedAt.delete(collector.key);
        this.ingestProgressLoggedAt.delete(collector.key);
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
    createCodexCollector({
      linkageCachePath: ingestCodexLinkageCachePath(stateDir),
    }),
    createCursorCollector(),
    createCopilotCollector(),
    createOpencodeCollector({
      fingerprintPath: ingestOpencodeFingerprintPath(stateDir),
    }),
  ];
}

const LARGE_IMPORT_BACKLOG_THRESHOLD = 50;
// Console-observability thresholds for the first-pass backfill (see the
// ingestStartedAt/ingestProgressLoggedAt fields). Only first passes with at
// least this many source files announce + log progress, and progress lines are
// throttled to at most one per interval so a large backlog can't spam the log.
const INGEST_LOG_MIN_SOURCES = 50;
const INGEST_LOG_INTERVAL_MS = 10_000;
// How often the catchup cache is flushed to disk DURING a long import pass, so a
// kill/restart resumes near where it left off rather than re-processing every
// source. The end-of-pass flush still runs; this only bounds the lost progress.
const CACHE_FLUSH_INTERVAL_MS = 10_000;
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

// FEA-2264: yield cadence for the cooperative source scan (see
// collectPendingSources). 256 keeps the added macrotask turns negligible (a few
// dozen over a multi-thousand-file history) while bounding any single
// synchronous stat run to a small slice.
const COLLECT_PENDING_YIELD_EVERY = 256;

// FEA-2264: how many sources to stat concurrently when warming the OS cache.
// statAsync runs on the libuv threadpool (default size 4), so this just bounds
// the in-flight promise count; awaiting per batch keeps the main thread free
// through the pre-warm.
const PREWARM_STAT_CONCURRENCY = 64;

// FEA-2264: warm the OS inode cache for every source OFF the main JS thread.
// statAsync runs on the libuv threadpool, so the kernel loads each file's inode
// while the main thread stays free; the synchronous statSync-heavy scan that
// follows (the codex rollout-graph build, isUnchanged, extraMtime) then hits
// warm caches instead of ~8k cold disk stats blocking the main thread. Errors
// are swallowed: a missing/inaccessible file is handled by the sync scan as
// before.
async function prewarmSourceStats(sources: readonly string[]): Promise<void> {
  for (
    let index = 0;
    index < sources.length;
    index += PREWARM_STAT_CONCURRENCY
  ) {
    const batch = sources.slice(index, index + PREWARM_STAT_CONCURRENCY);
    await Promise.all(
      batch.map((source) =>
        statAsync(source).then(
          () => undefined,
          () => undefined
        )
      )
    );
  }
}

async function collectPendingSources(
  collector: HarnessCollector,
  cache: CatchupCache | undefined,
  sources: string[],
  existingSessionIds?: ReadonlySet<string>,
  foldedChildSessionIds?: Set<string>
): Promise<PendingSource[]> {
  await prewarmSourceStats(sources);
  // File-only members (prepareSourceBatch/extraMtime) and the batch-only
  // sourceFingerprint are reached through these narrowed views; the prior
  // optional-chaining no-op for the other kind is preserved by the undefined.
  const { fileCollector, batchCollector } = narrowHarness(collector);
  // FEA-2264: prepareSourceBatch can be cooperative (the Codex collector builds
  // its rollout-linkage graph here, reading session_meta off every changed
  // rollout). Awaiting it lets that build yield to the event loop on a cold
  // cache instead of stat/reading thousands of files synchronously before the
  // per-source loop below even starts.
  await fileCollector?.prepareSourceBatch?.(sources);
  const pendingSources: PendingSource[] = [];
  // FEA-2264: this loop runs multiple synchronous statSync calls per source
  // (cache.isUnchanged plus the codex extraMtime workflow-journal/descendant
  // stats). Over a large history that is many thousands of blocking stats; yield
  // to the event loop every COLLECT_PENDING_YIELD_EVERY sources so renderer reads
  // and the cloud socket are serviced and the UI stays responsive while it runs.
  let sourcesSinceYield = 0;
  for (const source of sources) {
    if (++sourcesSinceYield >= COLLECT_PENDING_YIELD_EVERY) {
      sourcesSinceYield = 0;
      await yieldToEventLoop();
    }
    const extraMtime = fileCollector?.extraMtime
      ? fileCollector.extraMtime(source)
      : null;
    let stat: PendingSource["stat"] = null;
    if (!collector.batch && cache) {
      const status = cache.isUnchanged(source, extraMtime);
      const foldedChildSessionId = foldedChildSessionIdForSource(
        collector,
        source,
        existingSessionIds
      );
      const isBurst =
        status.unchanged && collector.isBurstArtifactSource?.(source) === true;
      if (isBurst) {
        if (foldedChildSessionId) {
          foldedChildSessionIds?.add(foldedChildSessionId);
        }
        continue;
      }
      const skipUnchanged =
        status.unchanged &&
        !isOrphanedFromDb(collector, source, existingSessionIds);
      if (skipUnchanged) {
        continue;
      }
      stat = status.stat;
    }
    const snapshot = batchCollector?.sourceFingerprint
      ? { fingerprint: batchCollector.sourceFingerprint(source) }
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
 * Current-revision Codex child rollouts fold into their root parent. If the
 * child was previously imported standalone while the parent was missing, a
 * later unchanged child source can otherwise be skipped before the empty-parse
 * cleanup path runs.
 */
function foldedChildSessionIdForSource(
  collector: HarnessCollector,
  source: string,
  existingSessionIds: ReadonlySet<string> | undefined
): string | null {
  // isBurstArtifactSource/sessionIdForSource are file-only; a batch collector
  // narrows to undefined here and the function returns null as before.
  const { fileCollector } = narrowHarness(collector);
  if (!(existingSessionIds && fileCollector?.isBurstArtifactSource?.(source))) {
    return null;
  }
  const sessionId = fileCollector.sessionIdForSource?.(source) ?? null;
  if (!(sessionId && existingSessionIds.has(sessionId))) {
    return null;
  }
  return sessionId;
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
  // sessionIdForSource is file-only; batch collectors are never orphan-checked
  // this way (their listSources is already unconditional), so undefined → false.
  const { fileCollector } = narrowHarness(collector);
  const sessionId = fileCollector?.sessionIdForSource?.(source) ?? null;
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
