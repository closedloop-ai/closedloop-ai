/**
 * @file sqlite-task-store.ts
 * @description FEA-3813 (PRD-553 M1) — the desktop SQLite implementation of the
 * crewd (`@repo/crewd`) `StorePort`.
 *
 * ── Why an in-memory mirror + write-behind ──────────────────────────────────
 * The crewd `StorePort` contract is SYNCHRONOUS (`listTasks(): ScheduledTask[]`,
 * `startRun(task): RunRecord`, …) because the crewd `Daemon` tick body is
 * synchronous — it reads tasks, launches due ones, and records runs inside one
 * non-awaited pass. The desktop local store, by contrast, is async Prisma over
 * libSQL and lives in the DB-host `utilityProcess`. To satisfy the sync contract
 * without blocking, `SqliteTaskStore` keeps the whole `StoreFile` (tasks + a
 * bounded run-history ring) in memory — hydrated ONCE from SQLite at
 * construction — and serves every synchronous `StorePort` read/mutation from it.
 * Each mutation ALSO enqueues an async write-behind that mirrors the change to
 * SQLite through the injected serialized `write` (the single-writer queue —
 * `prisma.write` in production; a real libSQL client in tests), so the durable
 * copy survives a restart and the M2 read surface can query it. The SQLite rows
 * are a mirror, never a second source of truth (PRD-553 §A) — losing them only
 * costs a re-hydrate, and the in-memory `StoreFile` is authoritative while the
 * process lives.
 *
 * This mirrors the JSON/file `TaskStore` (`@repo/crewd/store`), which is the
 * same in-memory-`StoreFile`-plus-persist shape; it passes the identical
 * `StorePort` conformance the CLI store passes.
 */

import { randomUUID } from "node:crypto";
import {
  CLOUD_ROUTINE_ID_META_KEY,
  emptyStore,
  hasSpentOneTimeFire,
  NATIVE_OWNER_META_KEY,
  nextRun,
  type RoutineRegistrar,
  type RunRecord,
  RunStatus,
  runRecordSchema,
  type ScheduledTask,
  type ScheduledTasksRegistrar,
  type StoreFile,
  type StorePort,
  scheduledTaskSchema,
  shouldStampFireCursor,
  TaskRoute,
  type TaskUpsert,
} from "@repo/crewd";
import {
  rowToRun,
  rowToTask,
  runToRow,
  type ScheduledTaskRow,
  type ScheduledTaskRunRow,
  taskToRow,
} from "./scheduled-task-rows.js";

/** Bound the in-memory run-history ring (matches the crewd JSON store). */
export const MAX_RUN_HISTORY = 500;

/**
 * The write-behind seam. In production this is `(fn) => prisma.write(fn)`, which
 * runs `fn` against the writer connection inside the single-writer queue (the
 * only mutation path — cf. the `@libsql` json_each SIGTRAP history, PRD-553 §A).
 * `fn` receives whatever the caller closes over; we keep it structurally minimal
 * so tests can inject a real libSQL `DesktopPrisma.write` verbatim.
 */
export type ScheduledTaskWriter = {
  scheduledTask: {
    upsert(
      args: {
        where: { id: string };
        create: ScheduledTaskRow;
        update: ScheduledTaskRow;
      } & IdSelect
    ): Promise<unknown>;
    delete(args: { where: { id: string } } & IdSelect): Promise<unknown>;
    update(
      args: {
        where: { id: string };
        data: Partial<ScheduledTaskRow>;
      } & IdSelect
    ): Promise<unknown>;
  };
  scheduledTaskRun: {
    create(args: { data: ScheduledTaskRunRow } & IdSelect): Promise<unknown>;
    update(
      args: {
        where: { id: string };
        data: Partial<ScheduledTaskRunRow>;
      } & IdSelect
    ): Promise<unknown>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<unknown>;
  };
};

/** The serialized write executor — `prisma.write` in production. */
export type WriteRunner = <T>(
  fn: (client: ScheduledTaskWriter) => Promise<T>
) => Promise<T>;

/** The read executor used ONCE to hydrate the in-memory mirror at construction. */
export type ReadRunner = <T>(
  fn: (client: ScheduledTaskReader) => Promise<T>
) => Promise<T>;

export type ScheduledTaskReader = {
  scheduledTask: {
    findMany(args?: unknown): Promise<ScheduledTaskRow[]>;
  };
  scheduledTaskRun: {
    findMany(args?: unknown): Promise<ScheduledTaskRunRow[]>;
  };
};

export type SqliteTaskStoreDeps = {
  write: WriteRunner;
  read: ReadRunner;
  /** Injectable clock; tests pin it so cron/next-run math is deterministic. */
  now?: () => Date;
  /** Key-free diagnostic log sink (write-behind failures). */
  log?: (message: string) => void;
  /**
   * FEA-3814 (PRD-553 M2): fired after any in-memory mutation (a task upsert /
   * removal / enable, or a run start / finish) so the read-only Scheduled Tasks
   * UI can be pushed a change signal. Payload-free — the consumer refetches
   * `listTasks()` / `listRuns()`. Never called for reads. Wrapped so a throwing
   * subscriber can't corrupt the store.
   */
  onChange?: () => void;
  /**
   * FEA-3816 (PRD-553 M4): the cloud-routine registration seam. When a task's
   * broker `route` flips to `claude-routine`, the store fires
   * `registrar.register(task)`; when it flips back to `local-cascade`, it fires
   * `registrar.deregister(task)`. Best-effort and fire-and-forget: the seam
   * resolves (never rejects) so a routine-service problem can never wedge the
   * upsert, and the persisted `route` is authoritative regardless. Omitted ⇒ no
   * cloud-routine wiring (the flip still persists the route).
   */
  routineRegistrar?: RoutineRegistrar;
  /**
   * FEA-3958 (PLN-1492) Slice A: the NATIVE local-scheduler registration seam.
   * When a task's broker `route` flips to `claude-scheduled-tasks`, the store
   * fires `scheduledTasksRegistrar.register(task)` to materialize it into Claude
   * Code's local `~/.claude/scheduled_tasks.json`; the reverse flip (or delete)
   * fires `deregister(task)`. Best-effort and fire-and-forget, exactly like
   * {@link routineRegistrar}: it resolves (never rejects) so a filesystem problem
   * can never wedge the upsert, and the persisted `route` is authoritative
   * regardless. Omitted ⇒ no native-scheduler wiring (the flip still persists the
   * route).
   */
  scheduledTasksRegistrar?: ScheduledTasksRegistrar;
};

const nowIso = (now: () => Date): string => now().toISOString();

export class SqliteTaskStore implements StorePort {
  private readonly deps: SqliteTaskStoreDeps;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private file: StoreFile = emptyStore();
  // Ordered write-behind chain: every mutation appends here so SQLite writes
  // apply in the same order the in-memory mutations happened, and a test can
  // await `whenIdle()` to flush them before asserting on the durable rows.
  private tail: Promise<void> = Promise.resolve();
  // Count of enqueued write-behinds — lets `whenIdle()` drain to a FIXED POINT
  // (a settling write can enqueue a follow-up), instead of resolving on a stale
  // tail snapshot.
  private enqueued = 0;
  // ISS-4814: in-flight `startRun` write-behinds, keyed by run id, so
  // `whenRunDurable(runId)` can await THAT launch's write reaching SQLite. Each
  // entry deletes itself when its write settles, so this stays bounded by the
  // number of concurrently-launching tasks rather than growing with run history.
  private readonly runDurability = new Map<string, Promise<void>>();

  private readonly onChange: () => void;
  private readonly routineRegistrar?: RoutineRegistrar;
  private readonly scheduledTasksRegistrar?: ScheduledTasksRegistrar;

  private constructor(deps: SqliteTaskStoreDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.routineRegistrar = deps.routineRegistrar;
    this.scheduledTasksRegistrar = deps.scheduledTasksRegistrar;
    // FEA-3814 (PRD-553 M2): guard the change subscriber so a throwing consumer
    // (e.g. a torn-down IPC push) can never corrupt a store mutation.
    this.onChange = () => {
      try {
        deps.onChange?.();
      } catch (error) {
        this.log(
          `SqliteTaskStore onChange subscriber threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
  }

  /** Construct and hydrate the in-memory mirror from SQLite (one read). */
  static async create(deps: SqliteTaskStoreDeps): Promise<SqliteTaskStore> {
    const store = new SqliteTaskStore(deps);
    await store.hydrate();
    return store;
  }

  private async hydrate(): Promise<void> {
    const { taskRows, runRows } = await this.deps.read(async (reader) => ({
      taskRows: await reader.scheduledTask.findMany(),
      runRows: await reader.scheduledTaskRun.findMany({
        orderBy: { startedAt: "desc" },
        take: MAX_RUN_HISTORY,
      }),
    }));
    this.file = {
      version: 1,
      tasks: taskRows.map(rowToTask),
      runs: runRows.map(rowToRun),
    };
  }

  /**
   * Resolves once every enqueued write-behind has settled — drained to a FIXED
   * POINT: it awaits the current tail, then re-checks whether the drain itself
   * caused new enqueues, looping until the enqueue count is stable. Deterministic
   * synchronization for tests + shutdown (no bounded polling).
   */
  async whenIdle(): Promise<void> {
    let seen = -1;
    while (seen !== this.enqueued) {
      seen = this.enqueued;
      await this.tail;
    }
  }

  /**
   * Append a mirror write to the ordered write-behind chain (never rejects).
   * After it returns, `this.tail` IS the promise for the write just appended —
   * that is how `startRun` gets a durability handle for exactly its own write
   * (ISS-4814's `whenRunDurable`) instead of using `whenIdle()`, which drains to
   * a global fixed point and would stall a launch behind unrelated traffic.
   */
  private enqueue(fn: (client: ScheduledTaskWriter) => Promise<void>): void {
    this.enqueued += 1;
    this.tail = this.tail.then(() =>
      this.deps.write(fn).then(
        () => undefined,
        (error: unknown) => {
          this.log(
            `SqliteTaskStore write-behind failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      )
    );
  }

  // ── tasks ──

  listTasks(): ScheduledTask[] {
    return this.file.tasks;
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.file.tasks.find((t) => t.id === id);
  }

  upsertTask(input: TaskUpsert): ScheduledTask {
    const id = input.id ?? randomUUID();
    const existing = this.getTask(id);
    const merged = scheduledTaskSchema.parse({
      ...(existing ?? {}),
      ...input,
      id,
      createdAt: existing?.createdAt ?? nowIso(this.now),
      updatedAt: nowIso(this.now),
    });
    const withNext: ScheduledTask = {
      ...merged,
      nextRunAt: this.computeNextRun(merged),
    };
    if (existing) {
      this.file.tasks = this.file.tasks.map((t) =>
        t.id === id ? withNext : t
      );
    } else {
      this.file.tasks.push(withNext);
    }
    const row = taskToRow(withNext);
    this.enqueue((client) =>
      client.scheduledTask
        .upsert({
          where: { id },
          create: row,
          update: row,
          select: { id: true },
        })
        .then(() => undefined)
    );
    // FEA-3816 (PRD-553 M4): reconcile the cloud routine when the broker route
    // changed (or on create). Runs AFTER the in-memory + write-behind mutation so
    // the persisted `route` is authoritative even if the remote seam is a no-op.
    this.reconcileRoutine(existing?.route, withNext);
    // FEA-3958 (PLN-1492) Slice A: reconcile the NATIVE local scheduler
    // (`claude-scheduled-tasks`) in parallel with the cloud routine, using its own
    // registrar and owner-meta key. Independent of the cloud path above.
    this.reconcileNativeSchedule(existing?.route, withNext);
    this.onChange();
    return withNext;
  }

  /**
   * FEA-3816 (PRD-553 M4): fire the cloud-routine registration seam when a task's
   * broker route flips. `local-cascade → claude-routine` registers the task as a
   * Claude cloud routine; the reverse deregisters it; a create straight into
   * `claude-routine` registers. Same-route upserts (a rename, a cron edit) do
   * nothing — and because a create has no previous route, an absent previous is
   * treated as `local-cascade` (the pre-M4 default), so creating an ordinary
   * local task never fires a spurious deregister for a routine that never
   * existed. Fire-and-forget and error-isolated: the seam resolves best-effort,
   * so a routine-service failure only logs — it can never wedge the upsert.
   */
  private reconcileRoutine(
    previousRoute: TaskRoute | undefined,
    task: ScheduledTask
  ): void {
    // A create has no prior route; an absent previous means "was not a cloud
    // routine", i.e. the local-cascade default — so a create into local-cascade
    // is a no-op, while a create into claude-routine still registers.
    const effectivePrevious = previousRoute ?? TaskRoute.LocalCascade;
    if (!this.routineRegistrar || effectivePrevious === task.route) {
      return;
    }
    const registering = task.route === TaskRoute.ClaudeRoutine;
    const action = registering
      ? this.routineRegistrar.register(task)
      : this.routineRegistrar.deregister(task);
    action
      .then((result) => {
        // FEA-3912: record CONFIRMED cloud ownership only when the registrar
        // actually accepted it. A confirmed `register` (ok + routineId) stamps
        // the marker the daemon keys its local-run suppression off; a failed or
        // unwired register (the stub reports ok:false) leaves NO marker, so the
        // daemon keeps running the task locally instead of dropping it. Any
        // deregister (or a route flipped back to local) clears the marker.
        if (registering && result.ok && result.routineId) {
          this.confirmCloudOwnership(task.id, result.routineId);
        } else {
          this.clearCloudOwnership(task.id);
        }
        if (!result.ok) {
          this.log(
            `routine reconcile for '${task.name}' (${task.id}) → ${task.route}: ${result.note}`
          );
        }
      })
      .catch((error: unknown) => {
        // A thrown registrar (contract violation — it must resolve) is treated
        // as unconfirmed: clear any marker so the daemon does not suppress the
        // local run on a failed registration.
        this.clearCloudOwnership(task.id);
        this.log(
          `routine reconcile for '${task.name}' (${task.id}) threw: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  /**
   * FEA-3958 (PLN-1492) Slice A: reconcile the NATIVE local scheduler
   * (`claude-scheduled-tasks`) with a task's current state. Parallel to
   * {@link reconcileRoutine} (the cloud path) but keyed on its own registrar and
   * the {@link NATIVE_OWNER_META_KEY} owner marker.
   *
   * Unlike the cloud path, this fires on more than a route flip, because the
   * native file is a full materialization (cron, prompt, recurring, durable) with
   * NO `enabled` field — so a stale native entry keeps firing in Claude Code
   * unless we re-materialize on the edits that change it:
   *   - route is `claude-scheduled-tasks` AND `enabled` ⇒ (re)register, so a
   *     cron/prompt/recurrence/durability edit — or the initial opt-in — refreshes
   *     the native entry (register is an id-keyed upsert, so this is idempotent).
   *   - route is `claude-scheduled-tasks` AND `!enabled` ⇒ deregister: a disabled
   *     Desktop task must be REMOVED from the native file (there is no `enabled`
   *     flag to carry the disabled state), or Claude Code keeps firing it.
   *   - a flip OUT of `claude-scheduled-tasks` (to any other route) ⇒ deregister.
   *   - never was and is not native ⇒ no-op.
   *
   * A create has no prior route; an absent previous is treated as `local-cascade`
   * (the pre-broker default). Fire-and-forget and error-isolated — a filesystem
   * failure only logs and clears the owner marker; it can never wedge the upsert.
   */
  private reconcileNativeSchedule(
    previousRoute: TaskRoute | undefined,
    task: ScheduledTask
  ): void {
    if (!this.scheduledTasksRegistrar) {
      return;
    }
    const effectivePrevious = previousRoute ?? TaskRoute.LocalCascade;
    const wasNative = effectivePrevious === TaskRoute.ClaudeScheduledTasks;
    const isNative = task.route === TaskRoute.ClaudeScheduledTasks;
    // An enabled native task is (re)registered on every upsert so field edits
    // refresh the native entry; a disabled or non-native task is deregistered
    // only when it currently holds (or just left) a native entry. Everything else
    // is a genuine no-op.
    const shouldRegister = isNative && task.enabled;
    const shouldDeregister = !shouldRegister && (wasNative || isNative);
    if (!(shouldRegister || shouldDeregister)) {
      return;
    }
    const action = shouldRegister
      ? this.scheduledTasksRegistrar.register(task)
      : this.scheduledTasksRegistrar.deregister(task);
    action
      .then((result) => {
        // Record CONFIRMED native ownership only when a REGISTER was accepted with
        // an owner id — that is the marker the daemon keys its local-run
        // suppression off. A deregister, a failed register, or an ok-without-owner
        // register all leave NO marker, so the daemon keeps owning the task
        // locally.
        if (shouldRegister && result.ok && result.ownerId) {
          this.stampOwnership(task.id, NATIVE_OWNER_META_KEY, result.ownerId);
        } else {
          this.stampOwnership(task.id, NATIVE_OWNER_META_KEY, undefined);
        }
        if (!result.ok) {
          this.log(
            `native-schedule reconcile for '${task.name}' (${task.id}) → ${task.route}: ${result.note}`
          );
        } else if (shouldRegister && !result.ownerId) {
          // A register that reports success but hands back no owner id cannot be
          // confirmed — the daemon would keep running the task locally while the
          // native scheduler also holds it (two eligible schedulers). This is a
          // registrar contract violation, not a normal failure, so surface it
          // rather than silently leaving the task unconfirmed.
          this.log(
            `native-schedule register for '${task.name}' (${task.id}) reported ok with no ownerId; treating as unconfirmed (task stays daemon-owned)`
          );
        }
      })
      .catch((error: unknown) => {
        this.stampOwnership(task.id, NATIVE_OWNER_META_KEY, undefined);
        this.log(
          `native-schedule reconcile for '${task.name}' (${task.id}) threw: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  /**
   * FEA-4054: reconcile the native scheduler on STARTUP, not just on a route
   * flip. `reconcileNativeSchedule` only fires on `upsertTask`/`removeTask`, so an
   * upgraded install whose `~/.claude/scheduled_tasks.json` is still in the old
   * (pre-FEA-4054) shape keeps native ownership stamped and the local daemon
   * suppressed while Claude Code loads ZERO jobs — until the operator happens to
   * edit the task. This pass re-materializes every enabled native task at boot so
   * the file is normalized to the current envelope and ownership is re-confirmed
   * (or CLEARED when the rewrite fails, so the daemon takes the task back rather
   * than leaving it running in neither scheduler). Each task is reconciled through
   * the same `reconcileNativeSchedule` path used by an upsert (passing the task's
   * OWN route as the "previous" so an enabled native task re-registers and a
   * disabled one deregisters); it is fire-and-forget and error-isolated per task.
   * A no-op when no native registrar is wired.
   */
  reconcileNativeSchedulesOnStartup(): void {
    if (!this.scheduledTasksRegistrar) {
      return;
    }
    for (const task of this.file.tasks) {
      if (task.route === TaskRoute.ClaudeScheduledTasks) {
        this.reconcileNativeSchedule(task.route, task);
      }
    }
  }

  /**
   * FEA-3912: stamp confirmed cloud-routine ownership onto a task's `meta` (the
   * daemon's local-run suppression predicate keys off this marker, not the raw
   * route). In-memory + write-behind + change signal, mirroring every other
   * mutation. A no-op if the task was removed while the (async) registration was
   * in flight.
   */
  private confirmCloudOwnership(id: string, routineId: string): void {
    this.stampOwnership(id, CLOUD_ROUTINE_ID_META_KEY, routineId);
  }

  /** FEA-3912: clear the confirmed cloud-routine ownership marker from a task. */
  private clearCloudOwnership(id: string): void {
    this.stampOwnership(id, CLOUD_ROUTINE_ID_META_KEY, undefined);
  }

  /**
   * Set (or delete) a confirmed-ownership marker under `metaKey` in a task's
   * `meta` and mirror the new `meta` to SQLite. Shared by the cloud-routine
   * (FEA-3912) and native-scheduler (FEA-3958) confirm/clear paths so the
   * in-memory, write-behind, and change-signal paths stay identical. A no-op if
   * the task was removed while the (async) registration was in flight, or if the
   * marker is already at the target value.
   */
  private stampOwnership(
    id: string,
    metaKey: typeof CLOUD_ROUTINE_ID_META_KEY | typeof NATIVE_OWNER_META_KEY,
    ownerId: string | undefined
  ): void {
    const task = this.getTask(id);
    if (!task || task.meta[metaKey] === (ownerId ?? undefined)) {
      return;
    }
    const nextMeta = { ...task.meta };
    if (ownerId === undefined) {
      delete nextMeta[metaKey];
    } else {
      nextMeta[metaKey] = ownerId;
    }
    const updated: ScheduledTask = { ...task, meta: nextMeta };
    this.file.tasks = this.file.tasks.map((t) =>
      t.id === task.id ? updated : t
    );
    const metaJson = JSON.stringify(nextMeta);
    this.enqueue((client) =>
      client.scheduledTask
        .update({
          where: { id },
          data: { meta: metaJson },
          select: { id: true },
        })
        .then(() => undefined)
    );
    this.onChange();
  }

  removeTask(id: string): boolean {
    const removedTask = this.getTask(id);
    this.file.tasks = this.file.tasks.filter((t) => t.id !== id);
    const removed = removedTask !== undefined;
    if (removed) {
      // Runs cascade-delete in SQLite (FK ON DELETE CASCADE); mirror that in the
      // memory ring so the history surface does not show orphaned runs.
      this.file.runs = this.file.runs.filter((r) => r.taskId !== id);
      this.enqueue((client) =>
        client.scheduledTask
          .delete({ where: { id }, select: { id: true } })
          .then(() => undefined)
      );
      // FEA-3816 (PRD-553 M4): deleting a task that was handed to a Claude cloud
      // routine must deregister that routine, or it would keep firing in the
      // cloud with no local task backing it. Reconcile against a synthetic
      // local-cascade target so a claude-routine task deregisters and a
      // local-cascade task is a no-op, reusing the same best-effort seam as a
      // route flip (fire-and-forget; a routine-service failure only logs).
      this.reconcileRoutine(removedTask.route, {
        ...removedTask,
        route: TaskRoute.LocalCascade,
      });
      // FEA-3958 Slice A: likewise, deleting a task that was materialized into
      // Claude Code's local scheduled_tasks.json must remove that native entry,
      // or it would keep firing with no local task backing it. Same synthetic
      // local-cascade target + best-effort seam as the cloud path above.
      this.reconcileNativeSchedule(removedTask.route, {
        ...removedTask,
        route: TaskRoute.LocalCascade,
      });
      this.onChange();
    }
    return removed;
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | undefined {
    const t = this.getTask(id);
    if (!t) {
      return undefined;
    }
    return this.upsertTask({ ...t, enabled });
  }

  advanceLastRun(id: string, iso: string): void {
    let changed = false;
    this.file.tasks = this.file.tasks.map((t) => {
      if (t.id !== id) {
        return t;
      }
      // Never move the cursor backward past a real local run's stamp.
      if (
        t.lastRunAt &&
        new Date(t.lastRunAt).getTime() >= new Date(iso).getTime()
      ) {
        return t;
      }
      changed = true;
      return { ...t, lastRunAt: iso };
    });
    if (!changed) {
      return;
    }
    this.enqueue((client) =>
      client.scheduledTask
        .update({
          where: { id },
          data: { lastRunAt: iso },
          select: { id: true },
        })
        .then(() => undefined)
    );
    this.onChange();
  }

  private computeNextRun(t: ScheduledTask): string | null {
    // ISS-4814: a SPENT one-time task has no next run. Before the durable fire
    // cursor, retirement meant `enabled: false`, so the guard above covered it;
    // now a spent task deliberately stays enabled (the pause flag is the
    // operator's, not the scheduler's), and without this it would keep
    // advertising the next matching cron slot forever — a slot the fire-once
    // guard in `Daemon.tickOnce` will always refuse.
    if (!t.enabled || hasSpentOneTimeFire(t)) {
      return null;
    }
    try {
      return nextRun(t.cron, this.now(), {
        timezone: t.timezone || undefined,
      }).toISOString();
    } catch {
      return null;
    }
  }

  refreshNextRuns(): void {
    let changed = false;
    for (const task of this.file.tasks) {
      const nextRunAt = this.computeNextRun(task);
      if (nextRunAt === task.nextRunAt) {
        continue;
      }
      changed = true;
      task.nextRunAt = nextRunAt;
      const id = task.id;
      this.enqueue((client) =>
        client.scheduledTask
          .update({
            where: { id },
            data: { nextRunAt },
            select: { id: true },
          })
          .then(() => undefined)
      );
    }
    if (changed) {
      this.onChange();
    }
  }

  // ── runs ──

  startRun(task: ScheduledTask): RunRecord {
    const rec = runRecordSchema.parse({
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      status: RunStatus.Running,
      startedAt: nowIso(this.now),
    });
    this.file.runs.unshift(rec);
    const evicted: string[] = [];
    if (this.file.runs.length > MAX_RUN_HISTORY) {
      for (const dropped of this.file.runs.slice(MAX_RUN_HISTORY)) {
        evicted.push(dropped.id);
      }
      this.file.runs = this.file.runs.slice(0, MAX_RUN_HISTORY);
    }
    // ISS-4814: fold the durable one-time fire cursor into the SAME task stamp
    // (and the same write-behind) as the launch record, so a crash can never land
    // between "the run started" and "the one fire is spent". Decided against the
    // CURRENT in-memory row, not the caller's launch-time snapshot.
    const current = this.getTask(task.id);
    const stamp = {
      lastRunAt: rec.startedAt,
      lastRunId: rec.id,
      lastStatus: rec.status,
      // Spending the one fire also retires the SCHEDULE: `nextRunAt` is what the
      // task list advertises as "runs next", and a spent one-time task has no
      // next run. Cleared in the same stamp rather than left to the next tick's
      // `refreshNextRuns`, so the surface never shows a future slot that the
      // fire-once guard will refuse — including on a daemon stopped right after
      // the fire.
      ...(current && shouldStampFireCursor(current)
        ? { firedAt: rec.startedAt, nextRunAt: null }
        : {}),
    };
    this.file.tasks = this.file.tasks.map((t) =>
      t.id === task.id ? { ...t, ...stamp } : t
    );
    const runRow = runToRow(rec);
    const taskId = task.id;
    // The run row is inserted BEFORE the task stamp on purpose: a kill between
    // the two leaves a task with no cursor, which the daemon correctly re-fires
    // — nothing was dispatched, because `Daemon.launch` waits on
    // `whenRunDurable` (below) before it dispatches. The reverse order would
    // durably retire a task that never ran.
    this.enqueue(async (client) => {
      await client.scheduledTaskRun.create({
        data: runRow,
        select: { id: true },
      });
      await client.scheduledTask.update({
        where: { id: taskId },
        data: stamp,
        select: { id: true },
      });
      if (evicted.length > 0) {
        // Bound the durable ring to match the in-memory ring (the mirror is a
        // recent-runs surface, not an audit log).
        await client.scheduledTaskRun.deleteMany({
          where: { id: { in: evicted } },
        });
      }
    });
    // `enqueue` just appended this write, so the tail IS its settle promise.
    this.runDurability.set(rec.id, this.tail);
    for (const dropped of evicted) {
      // Bound the map alongside the run ring: an entry nobody ever awaited is
      // dropped when its run falls out of history, so this can never outgrow
      // MAX_RUN_HISTORY. (`whenRunDurable` also deletes what it awaits.)
      this.runDurability.delete(dropped);
    }
    this.onChange();
    return rec;
  }

  /**
   * ISS-4814 — resolves once `startRun(runId)`'s launch record and one-time fire
   * cursor have reached SQLite. See `StorePort.whenRunDurable`: `Daemon.launch`
   * awaits this before dispatching, which is what turns the in-memory stamp into
   * a real crash barrier for this write-behind store. An unknown or
   * already-settled run id resolves immediately.
   */
  async whenRunDurable(runId: string): Promise<void> {
    const pending = this.runDurability.get(runId);
    if (!pending) {
      return;
    }
    await pending;
    this.runDurability.delete(runId);
  }

  finishRun(runId: string, patch: Partial<RunRecord>): RunRecord | undefined {
    let updated: RunRecord | undefined;
    this.file.runs = this.file.runs.map((r) => {
      if (r.id !== runId) {
        return r;
      }
      updated = runRecordSchema.parse({
        ...r,
        ...patch,
        finishedAt: patch.finishedAt ?? nowIso(this.now),
      });
      return updated;
    });
    if (!updated) {
      return undefined;
    }
    const finalStatus = updated.status;
    // Stamp the owning task's lastStatus (the run this finish belongs to is its
    // most-recent run) so the durable task row does not keep the `running`
    // placeholder that startRun wrote.
    const stampedTaskIds: string[] = [];
    this.file.tasks = this.file.tasks.map((t) => {
      if (t.lastRunId !== runId) {
        return t;
      }
      stampedTaskIds.push(t.id);
      return { ...t, lastStatus: finalStatus };
    });
    const runRow = runToRow(updated);
    this.enqueue(async (client) => {
      await client.scheduledTaskRun.update({
        where: { id: runId },
        data: {
          status: runRow.status,
          finishedAt: runRow.finishedAt,
          harnessUsed: runRow.harnessUsed,
          attempts: runRow.attempts,
          summary: runRow.summary,
          logPath: runRow.logPath,
          error: runRow.error,
        },
        select: { id: true },
      });
      // Mirror the task lastStatus stamp to SQLite (in-memory-only would leave a
      // durable `running` on the task row after a finished run).
      for (const taskId of stampedTaskIds) {
        await client.scheduledTask.update({
          where: { id: taskId },
          data: { lastStatus: finalStatus },
          select: { id: true },
        });
      }
    });
    this.onChange();
    return updated;
  }

  listRuns(taskId?: string, limit = 50): RunRecord[] {
    const runs = taskId
      ? this.file.runs.filter((r) => r.taskId === taskId)
      : this.file.runs;
    return runs.slice(0, limit);
  }

  // ── lifecycle ──

  reload(): void {
    // The in-memory `StoreFile` is authoritative for the running process (single
    // writer — this store owns every mutation), so there is no external mutator
    // to re-read from mid-tick. Hydration happens once in `create()`. A no-op
    // keeps the daemon's per-tick `reload()` cheap and side-effect-free.
  }

  snapshot(): StoreFile {
    return this.file;
  }
}

/**
 * REQUIRED rather than optional on purpose — a write that forgets it fails
 * `tsc` here instead of quietly hydrating a full row in the db-host worker.
 * `deleteMany` is absent because it already resolves a `{ count }`.
 */
type IdSelect = { select: { id: true } };
