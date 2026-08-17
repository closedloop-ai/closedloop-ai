/**
 * @file collector-manager.ts
 * @description Owns the in-process multi-harness collection layer (FEA-1503):
 * boot-time bulk import + live file watchers for all five agent CLIs (Claude,
 * Codex, Cursor, Copilot, OpenCode), writing through the injected importer into
 * the shared in-process DB. Started/stopped alongside the hook listener as part
 * of the always-on Agent Dashboard capture stack.
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
import type { QuarantinedStageCounts } from "../../../shared/ingest-quarantine-contract.js";
import type { Importer } from "../../dashboard/agent-dashboard-db-types.js";
import { captureInvocationDefinitionEvidence } from "../../packs/definition-content-collector.js";
import { delay } from "../../util/main-loop-scheduling.js";
import { type HarnessCollector, narrowHarness } from "../types.js";
import { BootImportLifecycle } from "./boot-import-watchdog.js";
import {
  HISTORICAL_IMPORT_SESSION_TIMEOUT_MS,
  importSessionBounded,
} from "./bounded-import-session.js";
import {
  type BoundedParseInvoker,
  HISTORICAL_PARSE_TIMEOUT_MS,
} from "./bounded-parse.js";
import {
  type CatchupCache,
  createCatchupCache,
  createPassSeenWriter,
} from "./catchup-cache.js";
import {
  CollectorImportScope,
  describeCollectorImportFailure,
} from "./collector-import-failure-log.js";
import { BatchResumeCursors } from "./collector-manager-batch-resume.js";
import { ImportPauseGate } from "./collector-manager-import-pause.js";
import {
  type IngestProgressSnapshot,
  IngestProgressTracker,
} from "./collector-manager-ingest-progress.js";
import { applyLiveSessionSinks } from "./collector-manager-live-session-sinks.js";
import {
  createImportPauses,
  createLiveYieldGate,
  type ImportPauses,
} from "./collector-manager-low-duty-pacing.js";
import type { CollectorManagerOptions } from "./collector-manager-options.js";
import {
  loadExistingSessionIds,
  parseHistoricalSource,
} from "./collector-manager-pass-resources.js";
import { scanImportPass } from "./collector-manager-pass-scan.js";
import { parseSourceForPass } from "./collector-manager-source-parse.js";
import {
  type DeferredImportTask,
  scheduleHarnessStartup,
} from "./collector-manager-startup.js";
import {
  createSourceBudgetSettler,
  LARGE_IMPORT_BACKLOG_THRESHOLD,
  sourcePathsForWatcherEventsWithOrigins,
  type WatcherEventSources,
  willSourceBeRescanned,
} from "./collector-pending-sources.js";
import { defaultCollectors } from "./default-collectors.js";
import {
  ingestBatchResumeCursorPath,
  ingestCachePath,
} from "./ingest-paths.js";
import {
  createParseQuarantine,
  type ParseQuarantine,
  parseQuarantinePath,
  quarantinedCountsByStage,
  totalQuarantinedCount,
} from "./parse-quarantine.js";
import { isImportableCollectorSource } from "./source-admission.js";
import type {
  HarnessImportControls,
  HarnessImportResult,
  HarnessWatcher,
  HarnessWatcherEvent,
} from "./watcher.js";

export class CollectorManager {
  private readonly options: CollectorManagerOptions;
  private readonly log: (message: string) => void;
  private readonly importer: Importer;
  private readonly collectors: HarnessCollector[];
  private readonly cooperativeDelay: (ms: number) => Promise<void>;
  private readonly pauses: ImportPauses;
  // ISS-4410: per-session bound (ms) for the historical import write, or `null`
  // to leave it unbounded. Guards the single unbounded await on the boot-import
  // critical path so one wedged session cannot stall the whole 1545-item sweep.
  private readonly historicalImportSessionTimeoutMs: number | null;
  // ISS-4444: per-source bound (ms) for the historical parse await, or `null` to
  // leave it unbounded. Guards the OTHER unbounded await on the boot-import
  // critical path (a CPU-spinning parser) so one poison transcript cannot wedge
  // the whole sweep.
  private readonly historicalParseTimeoutMs: number | null;
  // ISS-4444: passes a source may be dead-lettered before it is quarantined.
  private readonly parseQuarantineMaxAttempts: number | undefined;
  private readonly waitForRendererBackgroundSlot: () => Promise<void>;
  private readonly caches = new Map<string, CatchupCache>();
  // ISS-4444: per-collector persisted dead-letter store for parse-wedging sources,
  // keyed by source path. EVERY collector gets one (mirrors `caches` but is not
  // gated on `!batch`): batch collectors like OpenCode parse one DB per source, so
  // that DB path IS the quarantine unit — without a store a wedging `opencode.db`
  // re-ran its 90s kill cycle every boot/catch-up forever (wongk review).
  private readonly quarantines = new Map<string, ParseQuarantine>();
  // ISS-5028: session ids a mid-source yield already imported, so the resumed
  // pass fast-forwards past them instead of replaying the prefix (see
  // BatchResumeCursors). Survives a yield because it outlives `importSources`.
  // ISS-5161: and survives the PROCESS, because it is persisted — a batch
  // harness has no per-file catchup cache to checkpoint against, so without this
  // an interrupted backfill came back with an empty cursor and an unadvanced
  // store fingerprint and replayed the whole corpus. Assigned in the constructor
  // rather than inline because it needs `options.stateDir`.
  private readonly batchResume: BatchResumeCursors;
  private readonly watchers: HarnessWatcher[] = [];
  private readonly deferredImportTasks = new Set<DeferredImportTask>();
  private started = false;
  private stopped = false;
  private generation = 0;
  // FTUE first-pass ingest progress + its console-observability bookkeeping,
  // extracted to a sibling so this grandfathered file stays shrink-only. Owns the
  // per-harness progress map, the first-pass-done gate, and the preparing set.
  private readonly ingest: IngestProgressTracker;
  // Pause/resume for the long first-launch backfill, extracted to a sibling so
  // this grandfathered file stays shrink-only. Also read by the first-pass stall
  // watch, so a paused backfill is never reported as stalled (ISS-4917).
  private readonly pause = new ImportPauseGate();
  // FEA-4156: boot-import completion/timeout lifecycle. Owns the terminal state
  // (`complete` = all harnesses settled; `timedOut` = a wedged harness the
  // bounded watchdog gave up on, degraded and NOT complete) plus the timer, so
  // this grandfathered manager does not keep growing. Armed before awaiting the
  // per-harness promises and cleared once they settle (or on stop()).
  private readonly bootImport: BootImportLifecycle;

  constructor(options: CollectorManagerOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.ingest = new IngestProgressTracker(this.log);
    this.batchResume = new BatchResumeCursors({
      persistPath: ingestBatchResumeCursorPath(options.stateDir),
      log: this.log,
    });
    this.importer = options.importer;
    this.collectors =
      options.collectors ?? defaultCollectors(options, this.log);
    this.cooperativeDelay = options.cooperativeDelay ?? delay;
    this.pauses = createImportPauses({
      isStopped: () => this.stopped,
      delay: (ms) => this.cooperativeDelay(ms),
    });
    this.historicalImportSessionTimeoutMs =
      options.historicalImportSessionTimeoutMs === undefined
        ? HISTORICAL_IMPORT_SESSION_TIMEOUT_MS
        : options.historicalImportSessionTimeoutMs;
    this.historicalParseTimeoutMs =
      options.historicalParseTimeoutMs === undefined
        ? HISTORICAL_PARSE_TIMEOUT_MS
        : options.historicalParseTimeoutMs;
    this.parseQuarantineMaxAttempts = options.parseQuarantineMaxAttempts;
    this.waitForRendererBackgroundSlot =
      options.waitForRendererBackgroundSlot ?? (() => Promise.resolve());
    this.bootImport = new BootImportLifecycle({
      timeoutMs: options.bootImportWatchdogMs,
      isStopped: () => this.stopped,
      currentGeneration: () => this.generation,
      isPaused: () => this.pause.isPaused(),
      onComplete: () => this.options.onBootImportComplete?.(),
      onTimeout: () => this.options.onBootImportTimeout?.(),
      log: this.log,
    });
    for (const collector of this.collectors) {
      if (!collector.batch) {
        this.caches.set(
          collector.key,
          createCatchupCache({
            persistPath: ingestCachePath(options.stateDir, collector.cacheName),
          })
        );
      }
      // ISS-4444: a persisted parse-quarantine store for EVERY collector, so a
      // poison source is dead-lettered once and not re-parsed every launch.
      // wongk review: batch collectors (OpenCode) need this too — the store is
      // keyed by source path, and a batch collector's source IS its DB file
      // (`opencode.db`), so quarantining that whole path is the right granularity.
      // Without a store, a wedging `opencode.db` timeout left `recordSourceTimeout`
      // with an `undefined` quarantine and re-ran the 90s kill cycle every boot and
      // every 30-minute catch-up, never quarantining it.
      this.quarantines.set(
        collector.key,
        createParseQuarantine({
          persistPath: parseQuarantinePath(
            options.stateDir,
            collector.cacheName
          ),
          ...(this.parseQuarantineMaxAttempts === undefined
            ? {}
            : { maxAttempts: this.parseQuarantineMaxAttempts }),
        })
      );
    }
  }

  /** Start boot import + live watchers. Never blocks boot; never throws. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopped = false;
    this.bootImport.reset();
    const gen = ++this.generation;
    // The per-harness decision (skip / live watcher / deferred boot import) and
    // its staggered delay live in the startup sibling; this epoch keeps only the
    // handles it must tear down in stop() and the promises boot completion gates
    // on.
    const plan = scheduleHarnessStartup({
      collectors: this.collectors,
      isCollectorEnabled: this.options.isCollectorEnabled,
      getCollectionMode: this.options.getCollectionMode,
      historicalImportDelayMs: this.options.historicalImportDelayMs,
      historicalImportStaggerMs: this.options.historicalImportStaggerMs,
      catchupPollMs: this.options.catchupPollMs,
      watchDirectory: this.options.watchDirectory,
      runFullImport: (collector, viaWatcher, controls) =>
        this.runImportFor(collector, gen, viaWatcher, controls),
      runWatcherEventImport: (collector, events) =>
        this.runImportForWatcherEvents(collector, gen, events),
      log: this.log,
    });
    this.watchers.push(...plan.watchers);
    for (const task of plan.deferredTasks) {
      this.deferredImportTasks.add(task);
      void task.promise.finally(() => this.deferredImportTasks.delete(task));
    }
    if (plan.firstImportPromises.length === 0) {
      queueMicrotask(() => this.bootImport.complete(gen));
      return;
    }
    // FEA-4156: arm a bounded watchdog BEFORE awaiting the per-harness promises.
    // If any harness's first-import promise never settles (e.g. a wedged Claude
    // Code import), `Promise.allSettled` below would stay pending forever and the
    // first-launch import splash would hang with `complete` never flipping — the
    // renderer's per-harness stall backstop can't help while OTHER harnesses keep
    // advancing the aggregate count. On timeout the watchdog surfaces the degraded
    // `timedOut` signal (NOT completion) so the splash resolves into its graceful
    // partial-import state while the still-running collectors keep filling the DB.
    // The real completion always clears the watchdog first, so a genuine settle
    // and the timeout can't both fire.
    this.bootImport.arm(gen);
    void Promise.allSettled(plan.firstImportPromises).then(() => {
      this.bootImport.complete(gen);
    });
  }

  /** The harness collectors driven by this manager. */
  /**
   * Per-harness first-pass ingest progress for the FTUE dashboard. Harnesses
   * with no pending sources are omitted (only show a harness with ≥1 session).
   */
  getIngestProgress(): IngestProgressReport {
    return {
      // byHarness/total/processed/preparing come from the ingest tracker; the
      // boot-import terminal state and quarantine count are separate lifecycles.
      ...this.ingest.snapshot(),
      // ISS-5115 (wongk review): the import loop has ACKNOWLEDGED a pause by
      // actually parking on the gate. Distinct from `isImportPaused()`, which is
      // true from the instant the user asks and stays true through a whole
      // source-discovery scan the loop cannot interrupt. The startup panel says
      // "Pausing" until this flips, rather than claiming work already stopped.
      importParked: this.pause.isParked(),
      // Every harness's boot import has finished. Distinct from aggregate
      // `processed === total`, which is briefly true between staggered passes.
      complete: this.bootImport.isComplete(),
      // FEA-4156: the boot import gave up without settling (a wedged harness the
      // watchdog timed out on). Degraded, NOT complete — the splash resolves into
      // its graceful partial-import state and no post-boot maintenance is queued.
      timedOut: this.bootImport.isTimedOut(),
      // ISS-4444 / ISS-6115: how many transcripts have been QUARANTINED (their
      // parse wedged or their import exceeded its bound repeatedly, so they are no
      // longer retried). The boot import still COMPLETES
      // with these skipped — this count lets the UI honestly surface "N sessions
      // couldn't be imported" instead of silently under-counting.
      quarantinedCount: totalQuarantinedCount(this.quarantines.values()),
      // ISS-6115 (wongk review): the same population split by the stage that
      // quarantined it. `quarantinedCount` alone changed meaning when the import
      // bound started charging the store, and every renderer went on saying the
      // transcript "couldn't be read" — which is false for an import stall, since
      // the file was read and it is the WRITE that did not finish.
      quarantinedByStage: quarantinedCountsByStage(this.quarantines.values()),
    };
  }

  getCollectors(): readonly HarnessCollector[] {
    return this.collectors;
  }

  /** Pause the first-launch backfill (live-watcher imports are unaffected). */
  pauseImport(): void {
    this.pause.pause();
  }

  /** Resume a paused backfill and unblock the import loop. */
  resumeImport(): void {
    this.pause.resume();
  }

  isImportPaused(): boolean {
    return this.pause.isPaused();
  }

  /** Stop watchers, halt in-flight imports, flush caches. */
  stop(): void {
    this.stopped = true;
    // FEA-4156: cancel the boot-import watchdog so a stop()/start() restart never
    // fires it against a superseded generation (the watchdog guards on generation,
    // but leaving a timer armed just leaks a no-op callback).
    this.bootImport.clear();
    // Unblock a paused import so its loop can observe `stopped` and exit.
    this.resumeImport();
    // Drop the stranded first-pass progress entries + console bookkeeping, but
    // PRESERVE the first-pass gate (see IngestProgressTracker.resetForStop): the
    // gate is only set post-completion, and re-arming it on an in-process restart
    // of an already-imported machine would surface a routine catch-up as a false
    // "Importing your history" state.
    this.ingest.resetForStop();
    // ISS-5161: PERSIST the in-flight batch cursor before releasing it. `stop()`
    // is the ordinary quit path — exactly the interruption the cursor exists to
    // survive — so flushing here is what lets the next launch resume the batch
    // backfill instead of replaying the corpus. `clear()` only releases memory;
    // it deliberately does NOT discard what is on disk.
    this.batchResume.flush();
    this.batchResume.clear();
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
    // ISS-4444: persist any dead-letter / quarantine state recorded this session so
    // a stop()/restart doesn't lose a poison transcript's accrued wedging attempts.
    for (const quarantine of this.quarantines.values()) {
      quarantine.flush();
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
      // ISS-5262: this line AND the tracker's `abandoned at N/M …: <reason>`
      // below come from one classification (collector-import-failure-log.ts).
      const report = describeCollectorImportFailure(collector.key, error);
      this.log(report.line);
      // codex review (ISS-4917): the pass rejected AFTER beginPass, so drop its
      // tracker state here. Left in place it stays "in flight" forever and the
      // shared sweep reports a not-advancing line every window for a pass that
      // already ended. abandonPass does NOT set the first-pass gate, so the next
      // pass re-tracks rather than the failure reading as a completion.
      const budgeted = this.ingest.abandonPass(collector.key, report.reason);
      return { completed: report.passCompleted || !budgeted };
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
        resolveSources: () =>
          sourcePathsForWatcherEventsWithOrigins(collector, events),
        pruneCache: false,
        lowDutyImport: false,
      });
      if (result.imported > 0 && this.isImportActive(generation)) {
        this.options.emit();
      }
      return { completed: true };
    } catch (error) {
      // ISS-5262: same helper; no abandonPass (the live batch tracks no pass).
      this.log(
        describeCollectorImportFailure(
          collector.key,
          error,
          CollectorImportScope.Live
        ).line
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
      // Boot/backfill has no watcher events, so there is no "which file changed"
      // to report — the transcript lane's live trigger only fires for genuine
      // LiveWatcher imports anyway (see the importMode gate below).
      resolveSources: () => ({
        sources: collector
          .listSources()
          .filter((source) => isImportableCollectorSource(collector, source)),
        changedPathsBySource: new Map(),
      }),
      pruneCache: true,
      parseSource: parseHistoricalSource(
        collector,
        this.options.historicalParseRunner
      ),
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
    parseSource = (source, onDispatch) => {
      onDispatch();
      return collector.parse(source);
    },
  }: {
    collector: HarnessCollector;
    generation: number;
    viaWatcher: boolean;
    resolveSources: () => WatcherEventSources;
    pruneCache: boolean;
    lowDutyImport: boolean;
    shouldYieldToLiveEvents?: () => boolean;
    // ISS-4572: the parse invoker fires `onDispatch` when the parse is actually
    // dispatched (in-process: immediately; via the runner: past the shared
    // dispatch tail), so a bounded parse's deadline starts at dispatch.
    parseSource?: BoundedParseInvoker;
  }): Promise<ImportSourcesResult> {
    const cache = this.caches.get(collector.key);
    // ISS-4444: the parse-quarantine store for this collector, consulted ONLY on
    // the low-duty historical pass. Live-watcher events (a user editing a file)
    // must always retry, so they never see the quarantine.
    const quarantine = lowDutyImport
      ? this.quarantines.get(collector.key)
      : undefined;
    // Narrow the discriminated union once so the loop below can reach for
    // file-only members (sessionIdForSource/isBurstArtifactSource) or batch-only
    // members (markSourceImported) without re-narrowing at each interleaved use.
    // Each reference is `undefined` for the other kind, preserving the prior
    // optional-chaining no-op behavior.
    const { fileCollector, batchCollector } = narrowHarness(collector);
    // The scan phase (preparing yield, source enumeration, existing-id load,
    // pending computation, folded-child cleanup, progress-pass open) lives in
    // `collector-manager-pass-scan.ts`; everything below is the import loop.
    const scan = await scanImportPass({
      collector,
      cache,
      quarantine,
      generation,
      lowDutyImport,
      ingest: this.ingest,
      resolveSources,
      loadExistingSessionIds: () =>
        loadExistingSessionIds({
          collector,
          cache,
          lowDutyImport,
          listExistingSessionIds: this.options.listExistingSessionIds,
          log: this.log,
        }),
      waitForRendererBackgroundSlot: this.waitForRendererBackgroundSlot,
      isImportActive: (gen) => this.isImportActive(gen),
      deleteSessionRow: this.options.deleteSessionRow,
      log: this.log,
    });
    if (!scan.active) {
      return { imported: 0, completed: false };
    }
    const {
      sources,
      changedPathsBySource,
      pendingSources,
      existingSessionIds,
      trackProgress,
    } = scan;

    const throttleImports =
      pendingSources.length > LARGE_IMPORT_BACKLOG_THRESHOLD;
    let imported = 0;
    // Persist the catchup cache incrementally during the pass (the throttled
    // flush in the loop below): a kill mid-pass otherwise discards everything
    // marked seen so far, re-processing every source on the next launch.
    const seenWriter = cache ? createPassSeenWriter(cache) : undefined;
    // Profiling: accumulate where the per-source wall time goes so the throttled
    // progress line can report the average parse vs import cost, telling whether
    // the import is paced by parsing rollouts or by the db-host writes.
    let parseMsTotal = 0;
    let importMsTotal = 0;
    // ISS-5028: the live-event yield decision, floored so a never-draining event
    // queue cannot park this pass after a single source (see the module docstring).
    const liveYield = createLiveYieldGate(
      lowDutyImport,
      shouldYieldToLiveEvents
    );
    // wongk review (ISS-4917): count a source only at a TERMINAL outcome
    // (imported, dead-lettered, or skipped). Counting it when it STARTED made
    // the banner and the log say 1/N with nothing actually complete, and N/N
    // while the last source was still running, so a wedge was reported at the
    // wrong position — and the no-progress window it feeds started late.
    // ISS-5028: `durable` distinguishes a source that will NOT return in a later
    // pending scan from one left for retry, so the cumulative denominator tracks
    // the source population rather than the attempt count. The yield quantum
    // still counts every attempt, because an attempt costs real time whether or
    // not it ended durably. A DURABLE outcome also drops the source's resume
    // cursor, since that source will not return in a later pending scan and the
    // entry would be a pure orphan; a source left for retry keeps its cursor (see
    // the H3 note below).
    // ISS-5028 (wongk review): the mid-source resume cursor is BATCH-only and
    // LOW-DUTY-only. Declared here rather than at its use site because
    // `completeSource` below also has to know whether this pass owns a cursor.
    const useResumeCursor = lowDutyImport && batchCollector !== undefined;
    const completeSource = (source: string, durable: boolean) => {
      liveYield.noteSourceCompleted();
      // ISS-5161: a source only reaches a TERMINAL outcome while the pass is
      // still active. When `stop()` (or a superseding generation) broke the
      // session loop, this source was INTERRUPTED, not completed — dropping its
      // resume cursor here would discard the checkpoint that lets the NEXT
      // process pick the batch store up where this one left off, which is the
      // whole point of persisting it.
      // ISS-5161 (review H1): and only the pass that OWNS the cursor may drop it.
      // A live-watcher import for the same batch store runs with
      // `lowDutyImport: false`, never consults the cursor, and used to delete it
      // here — under sustained writes, which is exactly the condition that keeps
      // triggering the yield, that erased the checkpoint between the yield that
      // wrote it and the quantum that was going to use it. An orphan left by the
      // narrower gate cannot skip a session that changed underneath it: ISS-5161
      // (review H2) made the fingerprint gate universal, so EVERY cursor — in
      // memory as well as from disk — is honored only while the store still
      // carries the fingerprint its ids were recorded under (`validateEntry`).
      // ISS-5161 (review H3): and only a DURABLE outcome may drop it. The reason
      // is NOT that a retry attempt wrote nothing — `result.failed` and
      // `result.incomplete` leave the source for retry while the loop keeps
      // importing the sessions after them, and those do checkpoint. The invariant
      // that holds is narrower: only a FULLY-COMMITTED session is checkpointed
      // (the `!result.incomplete` guard below), so what the cursor carries past a
      // retry outcome is exactly the set that committed. Dropping it there
      // destroyed the durable checkpoint this cursor exists to be: one transient
      // SQLITE_BUSY on a locked OpenCode store sent the next pass back to session
      // zero, and sustained writes — the condition that triggers both the yield
      // and the lock — made that a throw/wipe/replay loop. `forget` at a durable
      // outcome keeps the map bounded; retry is bounded by one entry per source.
      if (useResumeCursor && durable && this.isImportActive(generation)) {
        this.batchResume.forget(collector.key, source);
      }
      if (trackProgress) {
        this.ingest.advance(
          collector.key,
          parseMsTotal,
          importMsTotal,
          durable
        );
      }
    };
    // ISS-5028: session ids this pass actually wrote. `existingSessionIds` is a
    // snapshot taken before the pass began, so without this a source imported a
    // moment ago still looks orphaned to willSourceBeRescanned.
    const importedThisPass = new Set<string>();
    // ISS-5028 (wongk review): the mid-source resume cursor, BATCH-only. A batch
    // source is the whole store, so a mid-source yield makes the next quantum
    // replay thousands of already-imported sessions; a file source is one
    // transcript, where the replay is cheap and the cursor would only add risk.
    // See BatchResumeCursors.
    const isSourceDurable = (source: string): boolean =>
      !willSourceBeRescanned(
        collector,
        source,
        existingSessionIds,
        importedThisPass
      );
    // ISS-5161 (wongk review): the store fingerprint proves only that the SOURCE
    // has not moved — it says nothing about the SINK. `agent-dashboard.sqlite`
    // lives at a sibling path and can be rebuilt (a DB reset/migration) while
    // the cursor file survives, the same divergence `loadExistingSessionIds`
    // already self-heals for file collectors. Fast-forwarding then skips ids out
    // of an EMPTY sink and `markSourceImported` seals the source over rows that
    // were never written. So a cursor may only skip a session the sink still
    // holds. `existingSessionIds` is this pass's snapshot, so a session written
    // EARLIER IN THIS CALL is absent from it — `importedThisPass` covers that,
    // and a later quantum re-reads the DB and sees it. An absent loader leaves
    // the pre-ISS-5161 behavior (trust the cursor) rather than replaying
    // everything.
    const sinkStillHolds = (sessionId: string): boolean =>
      existingSessionIds === undefined ||
      existingSessionIds.has(sessionId) ||
      importedThisPass.has(sessionId);
    // The pass returned early to service live-watcher events: not advancing BY
    // DESIGN, so the no-progress watch mutes this harness until it re-enters.
    const yieldToLiveEvents = (): ImportSourcesResult => {
      this.ingest.noteSuspended(collector.key);
      // ISS-5161: checkpoint the batch cursor at every yield. A MID-SOURCE yield
      // leaves the source unmarked by design, so this write is the only record
      // that the sessions already committed this pass need not be replayed — and
      // a yielded pass is precisely when the app is most likely to be quit.
      this.batchResume.flush();
      return { imported, completed: false };
    };

    for (const pendingSource of pendingSources) {
      if (!this.isImportActive(generation)) {
        break;
      }
      // Cooperative pause point: the user can pause the long first-launch
      // backfill from the import banner. Only the historical (lowDuty) pass is
      // pausable; live-watcher imports continue. Re-check active after resuming
      // since stop() may have fired while paused. wongk review (ISS-4917): the
      // no-progress watch is muted HERE, where the loop actually parks — not on
      // the pause flag, which flips while a parse/write is still in flight.
      if (lowDutyImport && this.pause.isPaused()) {
        this.ingest.noteSuspended(collector.key);
        // ISS-5028 (bot review): parked time is not time spent working, so it
        // must not accrue toward the quantum's time escape — otherwise any pause
        // longer than the quantum leaves the gate open on resume and the pass
        // yields after a single source.
        liveYield.noteParked();
        await this.pause.wait();
        liveYield.noteUnparked();
        this.ingest.noteResumed(collector.key);
        if (!this.isImportActive(generation)) {
          break;
        }
      }
      const sourceStartedAt = Date.now();
      const { source, stat, extraMtime, snapshot } = pendingSource;
      let sourceImported = true;

      const parsed = await parseSourceForPass({
        parseSource,
        collector,
        source,
        stat,
        extraMtime,
        cache,
        quarantine,
        lowDutyImport,
        parseTimeoutMs: this.historicalParseTimeoutMs,
        isImportActive: () => this.isImportActive(generation),
        abortInFlightParse: () =>
          this.options.historicalParseRunner?.abortInFlightParse?.(),
        log: this.log,
      });
      parseMsTotal += parsed.parseMs;
      const outcome = parsed.outcome;
      // One generation check for every outcome, ahead of any shared-state write:
      // a parse can span a ~90s bound, so a stop()/restart can supersede this
      // epoch mid-flight. Previously only the timeout path re-checked, so a
      // throw advanced the ingest progress of an epoch that had already ended.
      if (outcome.kind === "superseded" || !this.isImportActive(generation)) {
        sourceImported = false;
        break;
      }
      if (outcome.kind === "timedOut" || outcome.kind === "threw") {
        // ISS-5028 (wongk review): both terminal-without-sessions outcomes are
        // reported as DURABLE only when a later pending scan can no longer
        // return this source — the quarantining timeout attempt, and the
        // cache-marking throw whose row the orphan self-heal will not readmit.
        // Anything else is left for retry and must stay out of `processed`.
        const durable =
          outcome.kind === "timedOut"
            ? outcome.quarantined
            : outcome.markedSeen && isSourceDurable(source);
        completeSource(source, durable);
        if (throttleImports) {
          await this.pauses.afterLargeBacklogSource(sourceStartedAt);
        }
        // wongk review (ISS-4444 + ISS-5028): neither path may `continue` past
        // the shared yield check. A timeout that skipped it let the NEXT source
        // burn another full ~90s window before a live event queued during this
        // one was serviced; an error-only backlog could satisfy both the source
        // floor and the time escape while watcher events sat queued.
        if (liveYield.shouldYield()) {
          return yieldToLiveEvents();
        }
        continue;
      }
      const sessions = outcome.sessions;

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

      // ISS-6115 (wongk review): settled from the `finally` so EVERY exit from the
      // session loop charges or clears the budget, not just the fallthrough — an
      // importer rejection unwinds to `runImportFor.catch` and a batch mid-source
      // yield returns early. Nothing the settle reads depends on the post-loop
      // `finished`/`committed` bookkeeping, so settling here is equivalent on the
      // healthy path. See `createSourceBudgetSettler`.
      const budget = createSourceBudgetSettler({
        batchSource: collector.batch === true,
        harness: collector.key,
        isActive: () => this.isImportActive(generation),
        log: this.log,
        quarantine,
        source,
        stat,
      });
      try {
        for (const [index, session] of sessions.entries()) {
          if (!this.isImportActive(generation)) {
            sourceImported = false;
            break;
          }
          // ISS-5028 (wongk review): a mid-source yield leaves this source unmarked,
          // so the resumed pass re-parses it from session zero. Fast-forward past
          // what an earlier quantum of THIS pass already committed, or the prefix
          // is replayed on every resume and a batch store never finishes.
          if (
            useResumeCursor &&
            this.batchResume.isImported(
              collector.key,
              source,
              session.sessionId,
              snapshot?.fingerprint ?? null
            ) &&
            sinkStillHolds(session.sessionId)
          ) {
            continue;
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
          applyLiveSessionSinks({
            session,
            harness: collector.key,
            source,
            viaWatcher,
            lowDutyImport,
            generationIsCurrent: generation === this.generation,
            changedPaths: changedPathsBySource.get(source),
            onLiveTranscriptActivity: this.options.onLiveTranscriptActivity,
            captureDefinitionEvidence:
              this.options.captureInvocationDefinitionEvidence ??
              captureInvocationDefinitionEvidence,
            log: this.log,
          });
          const importStartedAt = Date.now();
          // ISS-4410: bound the historical import write so a single wedged
          // session (a DB-host write accepted but never completing) cannot
          // permanently stall the whole boot-import sweep at the first source.
          // Live-watcher imports stay unbounded (single, user-driven events).
          const result =
            lowDutyImport && this.historicalImportSessionTimeoutMs !== null
              ? await importSessionBounded(
                  this.importer,
                  this.log,
                  session,
                  collector.key,
                  source,
                  this.historicalImportSessionTimeoutMs,
                  budget.noteImportTimedOut
                )
              : await this.importer.importSession(session, collector.key);
          importMsTotal += Date.now() - importStartedAt;
          if (!this.isImportActive(generation)) {
            sourceImported = false;
            break;
          }
          // ISS-4476 / ISS-4444: a single session that failed to import — the
          // FK-parent gate threw on a mis-owned agent-id collision, or (ISS-4410)
          // its historical write exceeded the bound and `importSessionBounded`
          // returned a synthetic `failed` — must NOT halt the rest of the source.
          // A `batch: true` collector (OpenCode) parses many sessions from ONE
          // source; `break`ing here skipped every later session in the batch and —
          // because a batch source is only marked seen when `sourceImported` stays
          // true — left the whole poisoned batch to be retried on every sweep,
          // wedging the backfill at 1/N. Isolate the failure: log it, leave the
          // source unmarked (so it is retried and the failing session is not
          // permanently lost), and fall through so later sessions in the same
          // source still import this pass. Treated like `incomplete`, not like a
          // stop signal. NB (wongk review, ISS-4410): do NOT `continue` here — that
          // skipped the shared post-session yield below, so after a two-minute
          // ISS-4410 timeout a queued live event waited while the next historical
          // session entered another full timeout. Falling through runs the same
          // pause + shouldYieldToLiveEvents check every other outcome runs.
          if (result.failed) {
            sourceImported = false;
            this.log(
              `session import failed [${collector.key}]: ${session.sessionId} skipped this pass (source left unmarked for retry)`
            );
          }
          // A partial import (a tolerated record group failed to commit) must not
          // mark the source seen, so it is re-parsed next pass to retry the failed
          // group. Unlike a stop signal, it does NOT halt the rest of the source —
          // the remaining sessions still import this pass.
          if (result.incomplete) {
            sourceImported = false;
          }
          // A failed session imported nothing durable, so it does not count toward
          // the imported tally even though we fall through to the shared yield.
          const wroteNothing =
            result.failed || (result.skipped && !result.reactivated);
          if (!wroteNothing) {
            imported++;
            // ISS-5028: this session is committed, so it counts toward the
            // mid-source quantum AND is recorded as already done for the resume
            // cursor. Both are gated on a DURABLE write: a `{skipped, !reactivated}`
            // (FEA-2027 unsafe token count) or a failed import wrote no row, so
            // neither may be skipped on the resumed pass nor claimed as progress.
            liveYield.noteSessionImported();
            importedThisPass.add(session.sessionId);
            // ISS-5161 (wongk review): an INCOMPLETE session committed only some of
            // its record groups and just left the source unmarked for retry.
            // Checkpointing it would make a later quantum — after a yield or a
            // restart — SKIP it, let a clean suffix finish the source, and then let
            // `markSourceImported` seal the fingerprint with the failed record
            // group still missing, silently, until the store moves again. Only a
            // fully-committed session may be checkpointed; an incomplete one is
            // re-read on the resume, which is exactly the retry it was left for.
            if (useResumeCursor && !result.incomplete) {
              this.batchResume.noteImported(
                collector.key,
                source,
                session.sessionId,
                snapshot?.fingerprint ?? null
              );
            }
          }
          if (lowDutyImport && index < sessions.length - 1) {
            await this.pauses.afterHistoricalSession(sessionImportStartedAt);
            if (!this.isImportActive(generation)) {
              sourceImported = false;
              break;
            }
            // ISS-5028: the quantum also closes the MID-SOURCE starvation path.
            // Returning here leaves the SOURCE unmarked, so this source is
            // re-listed and re-parsed on the next resume — for a batch harness that
            // is the entire store — which is why this site takes the session-floor
            // gate rather than the source/time one, and why the sessions already
            // committed above are recorded on the resume cursor.
            //
            // ISS-5161 (wongk review): that only holds while the cursor can still
            // RECORD what this quantum imported. Once it saturates, every resume
            // replays the same recorded prefix, re-imports the same small
            // unrecorded tail, and yields again before reaching anything later —
            // so a corpus above the cap never finishes under a continuously
            // pending live queue. Past saturation the mid-source yield is
            // therefore disabled and the source runs to completion; the
            // per-session cooperative delay above still keeps the main thread
            // responsive, and the source-level yield after the loop still runs.
            const cursorCanRecordProgress = !(
              useResumeCursor &&
              this.batchResume.isSaturated(collector.key, source)
            );
            if (cursorCanRecordProgress && liveYield.shouldYieldMidSource()) {
              return yieldToLiveEvents();
            }
          }
        }
      } finally {
        budget.settle();
      }

      if (
        sourceImported &&
        this.isImportActive(generation) &&
        !collector.batch
      ) {
        seenWriter?.markSeen(source, stat, extraMtime);
      }
      // wongk review (ISS-5028): `sourceImported` only says the parse/import loop
      // succeeded — it does NOT say the snapshot was committed. OpenCode refuses
      // a snapshot that moved under the pass (opencode-collector.ts), so the same
      // sentinel returns as pending on the next resume. Take the commit result as
      // the durability signal; a collector without the hook keeps the prior
      // meaning (an absent hook cannot refuse).
      const finished = sourceImported && this.isImportActive(generation);
      const committed =
        finished &&
        batchCollector?.markSourceImported?.(source, snapshot) !== false;
      // ISS-6115: the attempt that crosses the budget is TERMINAL —
      // collectPendingSources filters a quarantined source out of every later scan
      // — so it is DURABLE for the same reason the parse-side timeout is.
      completeSource(
        source,
        budget.settle() || (committed && isSourceDurable(source))
      );
      if (throttleImports) {
        await this.pauses.afterLargeBacklogSource(sourceStartedAt);
      }
      if (liveYield.shouldYield()) {
        return yieldToLiveEvents();
      }
    }

    // First full pass for this harness finished — settle its bar to 100% and
    // stop re-tracking on later catch-up passes.
    if (trackProgress && this.isImportActive(generation)) {
      this.ingest.settlePass(collector.key);
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
    // ISS-4444: prune quarantine entries for sources no longer present (a deleted
    // transcript never returns), then persist the pass's recorded failures /
    // quarantines so a poison transcript isn't re-parsed from scratch next launch.
    if (quarantine) {
      if (this.isImportActive(generation) && pruneCache) {
        quarantine.pruneTo(sources);
      }
      quarantine.flush();
    }
    return { imported, completed: true };
  }

  private isImportActive(generation: number): boolean {
    return !(this.stopped || generation !== this.generation);
  }
}

type ImportSourcesResult = {
  imported: number;
  completed: boolean;
};

/**
 * What {@link CollectorManager.getIngestProgress} reports: the tracker's own
 * snapshot (per-harness counts, the scan flag, and ISS-5281's producer-owned
 * `drained`) plus the three lifecycles the manager owns beside it. Composed off
 * `IngestProgressSnapshot` rather than re-listing its fields, so a field added
 * there cannot silently go unreported here.
 */
type IngestProgressReport = IngestProgressSnapshot & {
  importParked: boolean;
  complete: boolean;
  timedOut: boolean;
  quarantinedCount: number;
  quarantinedByStage: QuarantinedStageCounts;
};
