/**
 * @file transcript-sync-service.ts
 * @description Orchestrator for the transcript archive lane (FEA-2715 /
 * PLN-1288 tasks 3 & 5). Entirely separate from `AgentSessionSyncService`. It:
 *   - drains queued files through the per-file executor on a 5s tick, `live`
 *     ahead of `backfill`, at bounded concurrency, with exponential-backoff +
 *     consecutive-failure dead-lettering (`transcript-drain-queue.ts`);
 *   - runs a full discovery sweep on start and every 30 min — the startup
 *     mini-backfill that catches sessions worked while the app was closed and,
 *     on first connect, IS the historical backfill (AC7)
 *     (`transcript-discovery-sweep.ts`);
 *   - accepts live enqueue from both live-capture channels: terminal Claude
 *     hook events flush immediately, activity events (hook OR watcher) enqueue
 *     on a ~5 min max-wait debounce so an active session's S3 object stays
 *     within ~5 min (AC4) without uploading on every tool call
 *     (`transcript-live-enqueue.ts`).
 *
 * This file is the coordinator, not the implementation: it owns the injected
 * options, the timer/clock/hash seams, the shared gates (`shouldRun`,
 * `tierAllowsSync`), and the store+executor cache, and hands each lane to the
 * module that owns it. All timing, filesystem, clock, and hashing is injected
 * so those lanes are unit-testable without real timers or disk. Transcript
 * failures never touch the metadata lane (PRD core decision 5) — this service
 * shares nothing with it.
 */
import { createHash } from "node:crypto";
import type { TranscriptForceArchiveResult } from "../../shared/transcript-read-contract.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  TranscriptSyncClass,
} from "../../shared/transcript-sync-status-contract.js";
import type { TranscriptSyncStore } from "../database/transcript-sync-store.js";
import {
  BackgroundTaskTracker,
  type QuiesceOutcome,
  type QuiesceTimerDeps,
} from "../lifecycle/sync-lane-quiesce.js";
import { TranscriptDiscoverySweeper } from "./transcript-discovery-sweep.js";
import {
  TranscriptDrainQueue,
  type TranscriptSyncRuntime,
} from "./transcript-drain-queue.js";
import type { TranscriptLiveActivity } from "./transcript-live-activity.js";
import { TranscriptLiveEnqueue } from "./transcript-live-enqueue.js";
import type { TranscriptObserveDeps } from "./transcript-observe.js";
import { observeTranscriptRef } from "./transcript-observe.js";
import {
  defaultScheduler,
  type Scheduler,
  type TimerHandle,
  type TranscriptHookPayload,
  type TranscriptSyncServiceOptions,
  type TranscriptSyncStatusSnapshot,
} from "./transcript-sync-options.js";
import {
  TRANSCRIPT_SYNC_CONCURRENCY,
  TRANSCRIPT_SYNC_SWEEP_INTERVAL_MS,
  TRANSCRIPT_SYNC_TICK_INTERVAL_MS,
  type TranscriptFileRef,
} from "./transcript-sync-types.js";

/**
 * ISS-4710: minimum wall-clock gap between `drain gated:` diagnostic lines. The
 * drain runs on a 5s tick, so a persistent gate (tier not consented, offline, no
 * store) would log every tick without this throttle. 60s keeps the signal (the
 * lane is gated) without flooding the log.
 */
const DRAIN_GATED_LOG_THROTTLE_MS = 60_000;

export class TranscriptSyncService {
  private started = false;
  private drainTimer: TimerHandle | null = null;
  private sweepTimer: TimerHandle | null = null;
  private cachedStore: TranscriptSyncStore | null = null;
  private cachedExecutor: TranscriptSyncRuntime["executor"] | null = null;
  /**
   * ISS-4710: last wall-clock ms a `drain gated:` diagnostic was emitted, so the
   * gated-drain log is throttled to at most one line per
   * {@link DRAIN_GATED_LOG_THROTTLE_MS} — the 5s drain tick would otherwise spam
   * it on every tick while a gate (tier/enabled/online/store) holds the lane off.
   */
  private lastDrainGatedLogAt = 0;
  /**
   * ISS-4903: every detached lane task is tracked here so shutdown can await
   * their tail before the db-host is disposed. Without it, `stop()` clears the
   * timers but a tick already in the air keeps reading/writing against a handle
   * the shutdown sequence is about to tear down — the `transcript task error:
   * db-host exited (code: 0)` cascade that landed AFTER shutdown reported clean.
   */
  private readonly inFlight = new BackgroundTaskTracker();

  private readonly opts: TranscriptSyncServiceOptions;
  private readonly scheduler: Scheduler;
  private readonly concurrency: number;

  private readonly observe: TranscriptObserveDeps;
  private readonly queue: TranscriptDrainQueue;
  private readonly sweeper: TranscriptDiscoverySweeper;
  private readonly live: TranscriptLiveEnqueue;

  constructor(options: TranscriptSyncServiceOptions) {
    this.opts = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.concurrency = options.concurrency ?? TRANSCRIPT_SYNC_CONCURRENCY;
    this.observe = {
      statFile: (filePath) => this.opts.statFile(filePath),
      hashPath: (filePath) => this.hashPath(filePath),
      getComputeTargetId: () => this.opts.getComputeTargetId?.() ?? null,
      now: () => this.now(),
    };
    this.queue = new TranscriptDrainQueue({
      shouldRun: () => this.shouldRun(),
      resolveRuntime: () => this.resolveRuntime(),
      getComputeTargetId: () => this.opts.getComputeTargetId?.() ?? null,
      now: () => this.now(),
      log: (message) => this.log(message),
      concurrency: this.concurrency,
    });
    this.sweeper = new TranscriptDiscoverySweeper({
      opts: this.opts,
      observe: this.observe,
      tierAllowsSync: () => this.tierAllowsSync(),
      now: () => this.now(),
      log: (message) => this.log(message),
      concurrency: this.concurrency,
      drainOnce: () => this.drainOnce(),
    });
    this.live = new TranscriptLiveEnqueue({
      opts: this.opts,
      scheduler: this.scheduler,
      observe: this.observe,
      tierAllowsSync: () => this.tierAllowsSync(),
      log: (message) => this.log(message),
      runDetached: (work) => this.runDetached(work),
      enqueueAndDrain: (ref) => this.enqueueAndDrain(ref),
      drainOnce: () => this.drainOnce(),
    });
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

  /**
   * Fire-and-forget a self-contained async task, logging any stray rejection.
   *
   * ISS-4903: the task is ALSO registered with `inFlight` so `quiesce()` can
   * await it during shutdown. Registration happens on the caught chain, so a
   * task that rejects still counts as settled (its failure is logged here, not
   * swallowed by the tracker).
   */
  private runDetached(work: Promise<unknown>): void {
    this.inFlight.track(
      work.catch((error) =>
        this.log(
          `transcript task error: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    );
  }

  /**
   * PRD-532 §7 consent gate: whether the chosen `syncObservabilityTier` permits
   * full session detail to leave the machine. Only the `full` tier does; tier
   * `metadata`/`local`, or the not-yet-consented `null`, returns false.
   * Undefined gate = not wired (legacy) = allowed. Gates both the drain
   * (`shouldRun`) AND the queue-growing
   * observe paths (sweep + hook enqueue) so a closed tier can't silently
   * accumulate `queued` rows the drain will never process (FEA-3463).
   */
  private tierGate(): TranscriptEgressGate {
    return this.opts.getCloudSyncTierGate?.() ?? TranscriptEgressGate.Allowed;
  }

  private tierAllowsSync(): boolean {
    // Only `Allowed` drains. `Unresolved` is not a denial, but it is not a
    // permission either, so egress keeps failing closed on it exactly as the
    // boolean gate did — the tri-state exists for the STATUS SNAPSHOT, which
    // must not render a pending policy as a settled no.
    return this.tierGate() === TranscriptEgressGate.Allowed;
  }

  /**
   * ISS-5387: is this lane actually able to deliver right now — started AND
   * every gate open (consent tier, feature enablement, cloud online, store
   * ready)? Read by the sync burn-down reporter, which must be able to tell
   * `idle_not_running` from `drained`: an empty transcript ledger behind a shut
   * gate has not caught up, it has stopped trying. Cheap and synchronous, unlike
   * {@link getStatusSnapshot}, so it is safe to poll.
   */
  isRunning(): boolean {
    return this.started && this.shouldRun();
  }

  private shouldRun(): boolean {
    // Honor the user's sync-observability consent: when the tier gate reports
    // the chosen tier does not permit full session detail to leave the machine,
    // suppress the transcript lane entirely — the consent contract wins over the
    // feature-flag/online preconditions.
    return (
      this.tierAllowsSync() &&
      this.opts.isEnabled() &&
      this.opts.isOnline() &&
      Boolean(this.opts.getStore())
    );
  }

  /** Resolve the current store + a matching executor, rebuilding on identity change. */
  private resolveRuntime(): TranscriptSyncRuntime | null {
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
    this.sweeper.resetForRestart();
    // The queue's in-flight claims are deliberately NOT cleared — those uploads
    // are still running and their keys must keep blocking a concurrent re-claim
    // of the same file; each drain clears its own key in its finally.
    if (this.drainTimer) {
      this.scheduler.clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.sweepTimer) {
      this.scheduler.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Reset the drain-gated log throttle alongside the timers so a stop/start
    // within DRAIN_GATED_LOG_THROTTLE_MS does not inherit the prior lifecycle's
    // timestamp and suppress the new lifecycle's first diagnostic.
    this.lastDrainGatedLogAt = 0;
    this.live.stop();
    // ISS-5337: the OpenCode materialize pass runs in a utilityProcess, so a
    // sweep can be parked on it for up to its own timeout. Cancel it here —
    // `stop()` runs BEFORE `quiesceDesktopSyncLanes` (ISS-4903), which waits
    // only ~2s for the detached sweep — otherwise the lane reports itself
    // stopped while a worker keeps writing projections, and the sweep resumes
    // against a db-host that shutdown has already disposed.
    this.opts.stopMaterialize?.();
  }

  /** Re-evaluate on a connectivity/state change (mirrors AgentSessionSyncService). */
  refresh(): void {
    if (this.shouldRun()) {
      this.runDetached(this.drainOnce());
    }
  }

  /** Full discovery pass — see `transcript-discovery-sweep.ts`. */
  sweepOnce(): Promise<void> {
    return this.sweeper.sweepOnce();
  }

  /** One bounded-concurrency upload pass — see `transcript-drain-queue.ts`. */
  drainOnce(): Promise<void> {
    this.logIfDrainGated();
    return this.queue.drainOnce();
  }

  /**
   * ISS-4710: emit a throttled `drain gated:` diagnostic when a tick can't drain
   * because a gate (`shouldRun`: tier/enabled/online/store) holds the lane off —
   * observability for the "transcript lane uploaded nothing during a rebuild"
   * condition. The queue re-checks the same gate and no-ops the actual drain; this
   * only adds the throttled note. Not the drain contract — behavior tests assert
   * the executor call, not this log.
   */
  private logIfDrainGated(): void {
    if (this.shouldRun()) {
      return;
    }
    const nowMs = Date.now();
    if (nowMs - this.lastDrainGatedLogAt < DRAIN_GATED_LOG_THROTTLE_MS) {
      return;
    }
    this.lastDrainGatedLogAt = nowMs;
    this.log(
      `drain gated: enabled=${this.opts.isEnabled()} online=${this.opts.isOnline()} tierAllows=${this.tierAllowsSync()} store=${Boolean(this.opts.getStore())}`
    );
  }

  /** Claude hook-channel trigger — see `transcript-live-enqueue.ts`. */
  enqueueClaudeHook(payload: TranscriptHookPayload): void {
    this.live.enqueueClaudeHook(payload);
  }

  /** Harness-agnostic watcher/hook activity trigger (FEA-3640 / ISS-4390). */
  enqueueActivity(activity: TranscriptLiveActivity): void {
    this.live.enqueueActivity(activity);
  }

  /**
   * User-initiated force-archive of one oversized transcript (FEA-3489).
   *
   * ISS-4903 (codex review): this is lane work like any timer/sweep task, just
   * driven by an IPC request instead of a tick, so it is registered with
   * `inFlight` too. Without that, a user hitting "Sync this transcript anyway"
   * and then quitting (or applying an update) mid-upload would let `quiesce()`
   * report drained on an empty tracker; shutdown would close the db-host and the
   * force operation's next settle would fail against a disposed proxy while
   * shutdown still reported clean. `track` takes no ownership of the promise and
   * is not a rejection handler, so the caller's promise (and its errors) still
   * reach the IPC caller unchanged.
   */
  forceSyncOversized(
    externalSessionId: string,
    fileKey: string
  ): Promise<TranscriptForceArchiveResult> {
    const work = this.queue.forceSyncOversized(externalSessionId, fileKey);
    this.inFlight.track(work);
    return work;
  }

  /** Per-file sync status for the desktop availability UI (FEA-2716/2717). */
  async getStatusSnapshot(): Promise<TranscriptSyncStatusSnapshot> {
    // ISS-4716: resolve the store ONCE and derive both `storeReady` and the
    // read below from that same local. Calling the live getter twice could
    // report `storeReady: true` alongside empty counts collected after the
    // runtime went away, which is exactly the "healthy but structurally
    // impossible" state the renderer footnote must never claim.
    const store = this.opts.getStore();
    const base = {
      enabled: this.opts.isEnabled(),
      online: this.opts.isOnline(),
      tierGate: this.tierGate(),
      storeReady: Boolean(store),
    };
    if (!store) {
      return { ...base, statusCounts: emptyTranscriptStatusCounts() };
    }
    return { ...base, statusCounts: await store.statusCounts() };
  }

  /**
   * Observe one ref as `live` and drain. FEA-3463: don't observe a live row the
   * drain will never process while the consent tier is closed — it would sit
   * `queued` and grow the queue unboundedly (the drain's `shouldRun` gate
   * already suppresses uploads). This gate is at the write point rather than at
   * the hook entry, so a debounce timer armed while the tier was open but firing
   * after it closed is suppressed too. The 30-min sweep re-discovers this
   * session once tier is set.
   */
  private async enqueueAndDrain(ref: TranscriptFileRef): Promise<void> {
    if (!this.tierAllowsSync()) {
      return;
    }
    const store = this.opts.getStore();
    if (!store) {
      return;
    }
    await observeTranscriptRef(
      this.observe,
      store,
      ref,
      TranscriptSyncClass.Live
    );
    await this.drainOnce();
  }

  /**
   * ISS-4903: await the tail of every detached lane task, bounded by
   * `budgetMs`. Shutdown calls this AFTER `stop()` (so no new tick is armed)
   * and BEFORE the db-host is disposed, so an upload already in the air commits
   * instead of failing against a torn-down handle.
   *
   * Returns `timed_out` when work is still in the air at the budget — the
   * caller degrades the shutdown verdict rather than reporting a false `clean`.
   * The budget is never unbounded: a wedged upload cannot hold the app open.
   */
  quiesce(
    budgetMs: number,
    timerDeps?: QuiesceTimerDeps
  ): Promise<QuiesceOutcome> {
    return this.inFlight.quiesce(budgetMs, timerDeps);
  }
}
