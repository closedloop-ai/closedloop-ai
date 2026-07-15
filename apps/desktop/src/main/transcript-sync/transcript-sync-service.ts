/**
 * @file transcript-sync-service.ts
 * @description Orchestrator for the transcript archive lane (FEA-2715 /
 * PLN-1288 tasks 3 & 5). Entirely separate from `AgentSessionSyncService`. It:
 *   - drains queued files through the per-file executor on a 5s tick, `live`
 *     ahead of `backfill`, at bounded concurrency, with exponential-backoff +
 *     consecutive-failure dead-lettering;
 *   - runs a full discovery sweep on start and every 30 min — the startup
 *     mini-backfill that catches sessions worked while the app was closed and,
 *     on first connect, IS the historical backfill (PLN-1288 tasks 3 & 5, AC7);
 *   - accepts hook-driven enqueue: terminal Claude events (Stop / SessionEnd /
 *     SubagentStop) enqueue immediately; activity events enqueue on a ~5 min
 *     max-wait debounce so an active session's S3 object stays within ~5 min
 *     (AC4) without uploading on every tool call.
 *
 * All timing, filesystem, clock, and hashing is injected so the queue/backoff
 * logic is unit-testable without real timers or disk. Transcript failures never
 * touch the metadata lane (PRD core decision 5) — this service shares nothing
 * with it.
 */
import { createHash } from "node:crypto";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import type { TranscriptSyncExecutor } from "./transcript-sync-executor.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS,
  TRANSCRIPT_SYNC_CONCURRENCY,
  TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES,
  TRANSCRIPT_SYNC_SWEEP_INTERVAL_MS,
  TRANSCRIPT_SYNC_TICK_INTERVAL_MS,
  type TranscriptFileRef,
  type TranscriptFileStat,
  type TranscriptFingerprint,
  TranscriptSyncClass,
  transcriptQueueKey,
  transcriptRetryDelayMs,
} from "./transcript-sync-types.js";

const READY_BATCH_LIMIT = 32;

/** Terminal Claude hook events that flush a transcript immediately. */
const TERMINAL_HOOK_TYPES = new Set(["Stop", "SessionEnd", "SubagentStop"]);

type TimerHandle = ReturnType<typeof setTimeout>;

type Scheduler = {
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

const defaultScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Per-file sync status projected for the availability UI (FEA-2716/2717). */
export type TranscriptFileStatus = {
  externalSessionId: string;
  fileKey: string;
  sourceHarness: string;
  status: string;
  syncClass: string;
  syncedByteOffset: number;
  lastSize: number | null;
  lastError: string | null;
};

export type TranscriptSyncStatusSnapshot = {
  enabled: boolean;
  online: boolean;
  files: TranscriptFileStatus[];
};

/** Minimal shape of a Claude hook payload the service consumes for triggers. */
export type TranscriptHookPayload = {
  hookType: string;
  sessionId?: string;
  transcriptPath?: string;
};

export type TranscriptSyncServiceOptions = {
  /** Null until the db-host runtime is ready; the service no-ops until then. */
  getStore: () => TranscriptSyncStore | null;
  /** Build the executor bound to a concrete store (cached per store identity). */
  buildExecutor: (store: TranscriptSyncStore) => TranscriptSyncExecutor;
  /**
   * Full-sweep discovery of every local transcript file. May be async so the
   * caller can lazy-`import()` the collector-backed discovery module (keeping it
   * off the desktop boot static-import graph — the agent-dashboard boundary).
   */
  discover: () => TranscriptFileRef[] | Promise<TranscriptFileRef[]>;
  /** Feature-flag gate — when false the service never runs (hard no-op). */
  isEnabled: () => boolean;
  /** Signed-in + relay-ready: uploads only proceed when true. */
  isOnline: () => boolean;
  /**
   * The live compute target id (or null offline). Passed through to
   * `observe` so a file synced under a previous target re-queues after a
   * target switch. Optional: omitted disables the target-switch check.
   */
  getComputeTargetId?: () => string | null;
  /**
   * Guard for hook-supplied transcript paths — the hook listener is an
   * unauthenticated localhost endpoint, so a path MUST be validated (anchored
   * under the known transcript root) before it can drive a raw byte upload.
   * Returns the resolved REAL path (symlinks followed, canonicalized) to be
   * uploaded, or `null` to reject; the service enqueues that resolved path so
   * the executor never re-opens the original symlink (which could be repointed
   * at a secret between check and read). Required, not optional: a new call site
   * that forgets to wire it would otherwise silently allow uploading any file
   * readable by the process. Tests pass a trivial `(path) => path` and exercise
   * the real anchoring separately.
   */
  resolveTrustedTranscriptPath: (path: string) => string | null;
  statFile: (path: string) => Promise<TranscriptFileStat | null>;
  now?: () => string;
  sourcePathHash?: (path: string) => string;
  log?: (message: string) => void;
  concurrency?: number;
  scheduler?: Scheduler;
};

function isoAfter(nowIso: string, deltaMs: number): string {
  return new Date(Date.parse(nowIso) + deltaMs).toISOString();
}

export class TranscriptSyncService {
  private started = false;
  private drainTimer: TimerHandle | null = null;
  private sweepTimer: TimerHandle | null = null;
  private readonly debounceTimers = new Map<string, TimerHandle>();
  private readonly inFlight = new Set<string>();
  private draining = false;
  /** Boot recovery (requeue stale `uploading` rows) runs once per start. */
  private staleRequeued = false;
  private cachedStore: TranscriptSyncStore | null = null;
  private cachedExecutor: TranscriptSyncExecutor | null = null;

  private readonly opts: TranscriptSyncServiceOptions;
  private readonly scheduler: Scheduler;
  private readonly concurrency: number;

  constructor(options: TranscriptSyncServiceOptions) {
    this.opts = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.concurrency = options.concurrency ?? TRANSCRIPT_SYNC_CONCURRENCY;
  }

  private now(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  private hashPath(path: string): string {
    return this.opts.sourcePathHash
      ? this.opts.sourcePathHash(path)
      : createHash("sha256").update(path).digest("hex");
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Fire-and-forget a self-contained async task, logging any stray rejection. */
  private runDetached(work: Promise<unknown>): void {
    work.catch((error) =>
      this.log(
        `transcript task error: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  private shouldRun(): boolean {
    return (
      this.opts.isEnabled() &&
      this.opts.isOnline() &&
      Boolean(this.opts.getStore())
    );
  }

  /** Resolve the current store + a matching executor, rebuilding on identity change. */
  private resolveRuntime(): {
    store: TranscriptSyncStore;
    executor: TranscriptSyncExecutor;
  } | null {
    const store = this.opts.getStore();
    if (!store) {
      this.cachedStore = null;
      this.cachedExecutor = null;
      return null;
    }
    if (store !== this.cachedStore || !this.cachedExecutor) {
      this.cachedStore = store;
      this.cachedExecutor = this.opts.buildExecutor(store);
    }
    return { store, executor: this.cachedExecutor };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (!this.opts.isEnabled()) {
      return;
    }
    this.drainTimer = this.scheduler.setInterval(() => {
      this.runDetached(this.drainOnce());
    }, TRANSCRIPT_SYNC_TICK_INTERVAL_MS);
    this.sweepTimer = this.scheduler.setInterval(() => {
      this.runDetached(this.sweepOnce());
    }, TRANSCRIPT_SYNC_SWEEP_INTERVAL_MS);
    // Startup mini-backfill + immediate drain.
    this.runDetached(this.sweepOnce());
  }

  stop(): void {
    this.started = false;
    // A fresh start re-runs crash recovery (a stop mid-upload can itself leave
    // an `uploading` row behind).
    this.staleRequeued = false;
    // Release the drain re-entrancy guard so a stop-then-start doesn't stall:
    // an interrupted drainOnce's Promise.all may still be pending, and without
    // this the restarted ticks would early-return until it settles. `inFlight`
    // is deliberately NOT cleared — those uploads are still running and their
    // keys must keep blocking a concurrent re-claim of the same file; each
    // processFile clears its own key in its finally.
    this.draining = false;
    if (this.drainTimer) {
      this.scheduler.clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.sweepTimer) {
      this.scheduler.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const handle of this.debounceTimers.values()) {
      this.scheduler.clearTimeout(handle);
    }
    this.debounceTimers.clear();
  }

  /** Re-evaluate on a connectivity/state change (mirrors AgentSessionSyncService). */
  refresh(): void {
    if (this.shouldRun()) {
      this.runDetached(this.drainOnce());
    }
  }

  /**
   * Discovery sweep: fingerprint every local transcript file (backfill class) so
   * files created/grown while the app was closed are enqueued, then drain. Runs
   * even while offline (queue is built locally; uploads wait for connectivity).
   */
  async sweepOnce(): Promise<void> {
    if (!this.opts.isEnabled()) {
      return;
    }
    const store = this.opts.getStore();
    if (!store) {
      return;
    }
    // Boot recovery: revive rows a crash/force-quit stranded in `uploading`
    // (ready queries exclude them and observe won't re-queue them). Runs on the
    // first sweep the store is available for, before the drain.
    if (!this.staleRequeued) {
      this.staleRequeued = true;
      const revived = await store.requeueStale(this.now());
      if (revived > 0) {
        this.log(`transcript sync requeued ${revived} stale uploading row(s)`);
      }
    }
    const refs = await this.opts.discover();
    await this.observeRefsBounded(store, refs);
    this.log(`transcript sweep observed ${refs.length} file(s)`);
    await this.drainOnce();
  }

  /**
   * Observe every discovered ref at bounded concurrency (FEA-2835). The sweep
   * previously awaited `observeRef` one ref at a time, so the whole discovery
   * pass was a sequential chain of `fs.stat` + `store.observe` IPC round-trips —
   * re-run on startup and every 30 min over potentially thousands of historical
   * transcripts. Running the refs in fixed-size batches lets the per-item stat
   * I/O and db-host IPC latency pipeline (the write-transactions still serialize
   * in the db-host regardless). There is no per-item try/catch, so a bounded
   * `Promise.all` preserves the prior abort-on-first-error behavior: a rejected
   * observe fails the batch and no later batch starts.
   */
  private async observeRefsBounded(
    store: TranscriptSyncStore,
    refs: TranscriptFileRef[]
  ): Promise<void> {
    const batchSize = Math.max(1, this.concurrency);
    for (let start = 0; start < refs.length; start += batchSize) {
      const batch = refs.slice(start, start + batchSize);
      await Promise.all(
        batch.map((ref) =>
          this.observeRef(store, ref, TranscriptSyncClass.Backfill)
        )
      );
    }
  }

  private async observeRef(
    store: TranscriptSyncStore,
    ref: TranscriptFileRef,
    syncClass: TranscriptSyncClass
  ): Promise<void> {
    const fileStat = await this.opts.statFile(ref.sourcePath);
    await store.observe({
      externalSessionId: ref.externalSessionId,
      fileKey: ref.fileKey,
      sourceHarness: ref.sourceHarness,
      sourcePath: ref.sourcePath,
      sourcePathHash: this.hashPath(ref.sourcePath),
      mtimeMs: fileStat?.mtimeMs ?? null,
      size: fileStat?.size ?? null,
      syncClass,
      currentComputeTargetId: this.opts.getComputeTargetId?.() ?? null,
      now: this.now(),
    });
  }

  /** Drain queued/failed files that are due, live-first, at bounded concurrency. */
  async drainOnce(): Promise<void> {
    if (this.draining || !this.shouldRun()) {
      return;
    }
    const runtime = this.resolveRuntime();
    if (!runtime) {
      return;
    }
    const available = this.concurrency - this.inFlight.size;
    if (available <= 0) {
      return;
    }
    this.draining = true;
    try {
      const ready = await runtime.store.listReady(
        this.now(),
        READY_BATCH_LIMIT
      );
      const toRun: TranscriptFingerprint[] = [];
      for (const fp of ready) {
        const key = transcriptQueueKey(fp.externalSessionId, fp.fileKey);
        if (!this.inFlight.has(key) && toRun.length < available) {
          this.inFlight.add(key); // claim synchronously before any await
          toRun.push(fp);
        }
      }
      await Promise.all(
        toRun.map((fp) => this.processFile(runtime.store, runtime.executor, fp))
      );
    } finally {
      this.draining = false;
    }
  }

  private async processFile(
    store: TranscriptSyncStore,
    executor: TranscriptSyncExecutor,
    fp: TranscriptFingerprint
  ): Promise<void> {
    const key = transcriptQueueKey(fp.externalSessionId, fp.fileKey);
    try {
      const result = await executor.syncFile(fp);
      // A successful upload that isn't caught up leaves the row queued; the next
      // drain tick continues it (bounded progress, no recursion).
      if (result.kind === "uploaded" && !result.caughtUp) {
        this.log(`transcript ${fp.fileKey} advanced; more to sync`);
      }
    } catch (error) {
      const retryCount = fp.retryCount + 1;
      const dead = retryCount >= TRANSCRIPT_SYNC_MAX_CONSECUTIVE_FAILURES;
      const message = error instanceof Error ? error.message : String(error);
      const nowIso = this.now();
      await store.recordFailure({
        externalSessionId: fp.externalSessionId,
        fileKey: fp.fileKey,
        retryCount,
        dead,
        nextAttemptAt: dead
          ? null
          : isoAfter(nowIso, transcriptRetryDelayMs(retryCount)),
        lastError: message,
        now: nowIso,
      });
      this.log(
        `transcript ${fp.fileKey} failed (attempt ${retryCount}${dead ? ", dead-lettered" : ""}): ${message}`
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Hook-driven enqueue for a Claude session's MAIN transcript. Terminal events
   * flush immediately; activity events schedule a single ~5 min max-wait timer
   * (not reset by later activity) so continuous sessions upload on a steady
   * cadence. Subagent files are covered by the discovery sweep.
   */
  enqueueClaudeHook(payload: TranscriptHookPayload): void {
    if (
      !(this.opts.isEnabled() && payload.sessionId && payload.transcriptPath)
    ) {
      return;
    }
    // The hook listener is an unauthenticated localhost endpoint, so the path is
    // attacker-influenceable. Resolve it to a canonical real path under the known
    // transcript root before it can drive a raw byte upload of an arbitrary
    // readable file; enqueue that resolved path (not the original candidate) so a
    // symlink can't be repointed at a secret between this check and the upload.
    const trustedPath = this.opts.resolveTrustedTranscriptPath(
      payload.transcriptPath
    );
    if (trustedPath === null) {
      this.log(`transcript hook rejected untrusted path: ${payload.hookType}`);
      return;
    }
    const ref: TranscriptFileRef = {
      externalSessionId: payload.sessionId,
      fileKey: TRANSCRIPT_MAIN_FILE_KEY,
      sourceHarness: "claude",
      sourcePath: trustedPath,
    };
    const key = transcriptQueueKey(ref.externalSessionId, ref.fileKey);
    if (TERMINAL_HOOK_TYPES.has(payload.hookType)) {
      this.clearDebounce(key);
      this.runDetached(this.enqueueAndDrain(ref));
      return;
    }
    // Activity: only arm a timer if none is pending (max-wait, not trailing).
    if (!this.debounceTimers.has(key)) {
      const handle = this.scheduler.setTimeout(() => {
        this.debounceTimers.delete(key);
        this.runDetached(this.enqueueAndDrain(ref));
      }, TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS);
      this.debounceTimers.set(key, handle);
    }
  }

  private clearDebounce(key: string): void {
    const handle = this.debounceTimers.get(key);
    if (handle) {
      this.scheduler.clearTimeout(handle);
      this.debounceTimers.delete(key);
    }
  }

  private async enqueueAndDrain(ref: TranscriptFileRef): Promise<void> {
    const store = this.opts.getStore();
    if (!store) {
      return;
    }
    await this.observeRef(store, ref, TranscriptSyncClass.Live);
    await this.drainOnce();
  }

  /** Per-file sync status for the desktop availability UI (FEA-2716/2717). */
  async getStatusSnapshot(): Promise<TranscriptSyncStatusSnapshot> {
    const base = {
      enabled: this.opts.isEnabled(),
      online: this.opts.isOnline(),
    };
    const store = this.opts.getStore();
    if (!store) {
      return { ...base, files: [] };
    }
    const rows = await store.listAll();
    return {
      ...base,
      files: rows.map((row) => ({
        externalSessionId: row.externalSessionId,
        fileKey: row.fileKey,
        sourceHarness: row.sourceHarness,
        status: row.status,
        syncClass: row.syncClass,
        syncedByteOffset: row.syncedByteOffset,
        lastSize: row.lastSize,
        lastError: row.lastError,
      })),
    };
  }
}
