/**
 * @file scheduler-service.ts
 * @description FEA-3813 (PRD-553 M1) — the desktop host for the crewd
 * (`@repo/crewd`) scheduler `Daemon`.
 *
 * `SchedulerService` owns the crewd `Daemon`, the {@link SqliteTaskStore} it ticks
 * over, and the daemon's lifetime. `boot()` starts it (gated on the Labs
 * `scheduledTasks` flag) and `shutdown()` disposes it, both in the DB host where
 * `prisma.write` is callable — the store's synchronous `StorePort` contract can
 * only be backed by the async writer connection from inside that process (see
 * `sqlite-task-store.ts`).
 *
 * ── Timer ownership ─────────────────────────────────────────────────────────
 * The crewd `Daemon` owns its own interval timer (`start()` / `stop()`) — the
 * portable replacement for a launchd plist — and unref's it so it never pins the
 * event loop. This service owns THAT daemon's lifecycle for the desktop app,
 * mirroring how `LoopSchedulerContext` owns the loop timers: a single container
 * whose `dispose()` guarantees the timer and any in-flight run are torn down.
 *
 * ── Dispatch (FEA-4143) ──────────────────────────────────────────────────────
 * The daemon's dispatch is {@link createScheduledReviewDispatch}, built from the
 * injected `runReview` proxy seam. A due `review`-kind task with a valid
 * night-crew config PROXIES its run to the main process, which composes it
 * through the on-demand `AuditService` (throwaway-workspace copy + main-side
 * credentials) — the daemon in the db-host child never runs the cascade itself
 * and never touches the live checkout. When no `runReview` proxy is wired (or a
 * task is not a review / carries no config), the dispatch degrades to the
 * historical M1 recorded `skipped` run: the task still FIRES and its run row
 * still PERSISTS, without spawning any CLI. A caller can still inject an explicit
 * `dispatch` to override the default entirely (tests).
 */

import {
  type CascadeStep,
  Daemon,
  type Dispatch,
  HarnessName,
  type LockPort,
  nextRun,
  noopLock,
  type RoutineRegistrar,
  type RunRecord,
  type ScheduledTask,
  type ScheduledTasksRegistrar,
  type TaskUpsert,
  validateCron,
} from "@repo/crewd";
import {
  createScheduledReviewDispatch,
  type ScheduledReviewRunner,
} from "./scheduled-review-dispatch.js";
import {
  SqliteTaskStore,
  type SqliteTaskStoreDeps,
} from "./sqlite-task-store.js";

/** Default tick cadence — the daemon wakes on this interval to fire due tasks. */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;

/** Default number of upcoming fire times the schedule preview returns. */
export const SCHEDULE_PREVIEW_DEFAULT_COUNT = 3;
/** Upper bound on the schedule preview fire-time count (clamps untrusted input). */
export const SCHEDULE_PREVIEW_MAX_COUNT = 10;

export type SchedulerServiceDeps = {
  /** The write/read seams + clock that back the SQLite-mirrored task store. */
  store: SqliteTaskStoreDeps;
  /**
   * The default `(harness, model)` cascade the daemon passes to each dispatch
   * for a task whose own cascade is empty. Defaults to the crewd
   * `[codex, opencode, claude]` "Switzerland" order on each harness's default
   * model (order is data).
   */
  defaultCascade?: readonly CascadeStep[];
  /** Tick cadence; defaults to {@link DEFAULT_SCHEDULER_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * FEA-4143: the child→main proxy that runs a scheduled review through the
   * main-process `AuditService`. When set, the default dispatch executes a
   * configured `review` task through it; when absent, the default dispatch
   * degrades to the historical recorded-skip (fires + persists, spawns nothing).
   * Ignored when an explicit {@link dispatch} is injected.
   */
  runReview?: ScheduledReviewRunner;
  /**
   * The run executor. Defaults to {@link createScheduledReviewDispatch} built
   * from {@link runReview}; tests can inject an explicit dispatch to override.
   */
  dispatch?: Dispatch;
  /**
   * Single-instance guard. The DB host is already a single process, so the
   * default no-op lock is correct here (a `FileLock` is the CLI's concern).
   */
  lock?: LockPort;
  /** Injectable clock, forwarded to the daemon (tests pin it). */
  now?: () => Date;
  /** Key-free diagnostic log sink. */
  log?: (message: string) => void;
  /**
   * FEA-3814 (PRD-553 M2): fired after any task/run mutation in the store (a
   * tick firing a run, a run finishing, an enable/upsert/remove). The db host
   * wires this to push `desktop:scheduled-tasks:changed` so the read-only UI
   * refetches. Payload-free; forwarded to the store's `onChange`.
   */
  onChange?: () => void;
  /**
   * FEA-3816 (PRD-553 M4): the cloud-routine registration seam, forwarded to the
   * store. Fired when a task's broker `route` flips to/from `claude-routine`.
   * Omitted ⇒ no cloud-routine wiring (the flip still persists the route).
   */
  routineRegistrar?: RoutineRegistrar;
  /**
   * FEA-3958 (PLN-1492) Slice A: the NATIVE local-scheduler registration seam,
   * forwarded to the store. Fired when a task's broker `route` flips to/from
   * `claude-scheduled-tasks` to materialize/remove it in Claude Code's local
   * `~/.claude/scheduled_tasks.json`. Omitted ⇒ no native-scheduler wiring (the
   * flip still persists the route).
   */
  scheduledTasksRegistrar?: ScheduledTasksRegistrar;
};

const DEFAULT_CASCADE: readonly CascadeStep[] = [
  { harness: HarnessName.Codex },
  { harness: HarnessName.Opencode },
  { harness: HarnessName.Claude },
];

export class SchedulerService {
  private readonly deps: SchedulerServiceDeps;
  private readonly log: (message: string) => void;
  private store: SqliteTaskStore | null = null;
  private daemon: Daemon | null = null;
  private started = false;

  constructor(deps: SchedulerServiceDeps) {
    this.deps = deps;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Hydrate the SQLite-mirrored store and start the daemon tick loop. Idempotent
   * — a second `start()` while running is a no-op. Gated by the caller on the
   * `scheduledTasks` Labs flag (this method itself does not read the flag, so it
   * stays testable without a settings store).
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    // FEA-3814 (PRD-553 M2): forward the change subscriber into the store so any
    // task/run mutation pushes a refetch signal. The store's own `onChange` (if
    // the caller set one there) still wins; the service-level one is the wiring
    // the db host uses.
    this.store = await SqliteTaskStore.create({
      ...this.deps.store,
      onChange: this.deps.store.onChange ?? this.deps.onChange,
      // FEA-3816 (PRD-553 M4): forward the cloud-routine seam so a broker-route
      // flip reconciles the Claude routine. The store-level dep (if the caller
      // set one there) wins; the service-level one is the db-host wiring.
      routineRegistrar:
        this.deps.store.routineRegistrar ?? this.deps.routineRegistrar,
      // FEA-3958 Slice A: forward the native local-scheduler seam so a broker-route
      // flip to `claude-scheduled-tasks` materializes the entry. Store-level dep
      // wins; the service-level one is the db-host wiring.
      scheduledTasksRegistrar:
        this.deps.store.scheduledTasksRegistrar ??
        this.deps.scheduledTasksRegistrar,
    });
    // FEA-4054: reconcile the native Claude scheduler on boot. The per-upsert
    // reconcile only fires on an edit, so an upgraded install whose
    // `scheduled_tasks.json` is still in the pre-FEA-4054 shape would keep native
    // ownership stamped (daemon suppressed) while Claude loads zero jobs until an
    // edit. Re-materializing enabled native tasks here normalizes the file and
    // re-confirms (or clears, on rewrite failure) ownership at startup.
    this.store.reconcileNativeSchedulesOnStartup();
    this.daemon = new Daemon(
      {
        store: this.store,
        dispatch:
          this.deps.dispatch ??
          createScheduledReviewDispatch(this.deps.runReview),
        lock: this.deps.lock ?? noopLock,
        now: this.deps.now,
        log: this.log,
      },
      {
        defaultCascade: this.deps.defaultCascade ?? DEFAULT_CASCADE,
        intervalMs: this.deps.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      }
    );
    this.daemon.start();
    this.started = true;
    this.log("scheduler: daemon started");
  }

  /** The live task store, or null before `start()` / after `dispose()`. */
  getStore(): SqliteTaskStore | null {
    return this.store;
  }

  /**
   * FEA-3814 (PRD-553 M2): the current task list — a structured-clone-safe
   * snapshot for the read-only Scheduled Tasks UI. Returns `[]` before `start()`
   * (the store is only hydrated then), so a read before the daemon boots is an
   * empty list, never a throw. Read-only: no mutation crosses this seam.
   */
  listTasks(): ScheduledTask[] {
    return this.store?.listTasks() ?? [];
  }

  /**
   * FEA-3814 (PRD-553 M2): recent run history, optionally scoped to one task,
   * for the run-history drawer (the cascade trail lives on each run's
   * `attempts`). Returns `[]` before `start()`. Read-only.
   */
  listRuns(taskId?: string, limit?: number): RunRecord[] {
    if (!this.store) {
      return [];
    }
    // Forward `limit` only when supplied so the store's own default applies
    // (passing an explicit `undefined` would defeat the parameter default).
    return limit === undefined
      ? this.store.listRuns(taskId)
      : this.store.listRuns(taskId, limit);
  }

  /**
   * FEA-3853 (PRD-553 M3): create a new task or replace an existing one (by id)
   * from the create/edit modal's validated save payload. The store fills the
   * bookkeeping fields (id, timestamps, `nextRunAt`) and re-validates through the
   * crewd schema, so a bad payload can never persist. Returns the stored task, or
   * throws when the daemon is not running (the flag gates that at boot). The
   * store's own `onChange` fires the `changed` push, so the UI refetches.
   */
  upsertTask(input: TaskUpsert): ScheduledTask {
    if (!this.store) {
      throw new Error("scheduler not running");
    }
    return this.store.upsertTask(input);
  }

  /**
   * FEA-3853 (PRD-553 M3): delete a task by id (its runs cascade in the store).
   * Returns true when a task was removed. Throws when the daemon is not running.
   */
  removeTask(id: string): boolean {
    if (!this.store) {
      throw new Error("scheduler not running");
    }
    return this.store.removeTask(id);
  }

  /**
   * FEA-3853 (PRD-553 M3): flip a task's `enabled` flag by id (the list-row
   * toggle). Recomputes `nextRunAt` (a disabled task has none). Returns the
   * updated task, or undefined for an unknown id. Throws when not running.
   */
  setEnabled(id: string, enabled: boolean): ScheduledTask | undefined {
    if (!this.store) {
      throw new Error("scheduler not running");
    }
    return this.store.setEnabled(id, enabled);
  }

  /**
   * FEA-3853 (PRD-553 M3): fire one task once immediately, off-schedule ("Run
   * now"). Runs it through the daemon's normal `startRun` → dispatch → `finishRun`
   * path so the run + cascade trail are recorded identically to a scheduled fire.
   * Returns false when the id is unknown or a run is already in flight (so a
   * double-click cannot double-fire); throws when the daemon is not running.
   */
  runNow(id: string): boolean {
    if (!this.daemon) {
      throw new Error("scheduler not running");
    }
    return this.daemon.runNow(id);
  }

  /** True once `start()` has completed and the daemon is running. */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * FEA-3853 (PRD-553 M3): validate a cron and preview its next `count` fire
   * times (the create/edit modal's live "next 3 runs" preview). Pure over the
   * crewd cron primitive — no store, so it works before `start()`. `count` is
   * clamped to 1..10 (default 3). An invalid cron returns `valid: false` with the
   * parser's message and no fire times, never a throw.
   */
  static previewSchedule(
    cron: string,
    timezone: string,
    count = SCHEDULE_PREVIEW_DEFAULT_COUNT
  ): { valid: boolean; error: string | null; nextRuns: string[] } {
    const validation = validateCron(cron);
    if (!validation.ok) {
      return {
        valid: false,
        error: validation.error ?? "Invalid schedule",
        nextRuns: [],
      };
    }
    const clamped = Math.max(1, Math.min(count, SCHEDULE_PREVIEW_MAX_COUNT));
    const opts = timezone ? { timezone } : undefined;
    const nextRuns: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < clamped; i++) {
      const fire = nextRun(cron, cursor, opts);
      nextRuns.push(fire.toISOString());
      cursor = fire;
    }
    return { valid: true, error: null, nextRuns };
  }

  /**
   * Run a single tick synchronously (tests + run-now). Resolves the daemon's
   * `tickOnce`; a no-op before `start()`.
   */
  async tickOnce(): Promise<void> {
    if (this.daemon) {
      await this.daemon.tickOnce();
    }
  }

  /**
   * Await every in-flight run + every pending write-behind. A run's `finishRun`
   * enqueues its write synchronously inside the dispatch IIFE that `daemon.drain()`
   * awaits, so draining the daemon first guarantees the finish write is on the
   * store's write-behind chain before `whenIdle()` reads it. `whenIdle()` itself
   * drains that chain to a fixed point. Deterministic synchronization (no bounded
   * polling) for tests + shutdown.
   */
  async drain(): Promise<void> {
    await this.daemon?.drain();
    await this.store?.whenIdle();
  }

  /**
   * Stop the daemon timer, await in-flight runs + pending write-behinds, and
   * release the store. Idempotent. Called from the desktop `shutdown()` path.
   */
  async dispose(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await this.daemon?.stop();
    await this.store?.whenIdle();
    this.daemon = null;
    this.store = null;
    this.log("scheduler: daemon disposed");
  }
}
