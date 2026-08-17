/**
 * Durable task store — the on-disk `scheduled_tasks.json`. Shape is a superset
 * of Claude Code's own store so a live claude session can read it. Writes are
 * atomic (tmp + rename). Run history is a bounded ring so the file stays small
 * while still backing the Desktop-UX "recent runs" list.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  emptyStore,
  hasSpentOneTimeFire,
  NATIVE_OWNER_META_KEY,
  type RunRecord,
  type RunStatus,
  runRecordSchema,
  type ScheduledTask,
  type StoreFile,
  scheduledTaskSchema,
  shouldStampFireCursor,
  storeFileSchema,
  TaskRoute,
} from "../model.js";
import { nextRun, validateCron } from "./cron.js";
import type { ScheduledTasksRegistrar } from "./routine-registrar.js";
import type { StorePort, TaskUpsert } from "./store-port.js";

export const MAX_RUN_HISTORY = 500;

export function defaultStorePath(): string {
  const base = process.env.CREW_HOME || `${homedir()}/.config/crew`;
  return `${base}/scheduled_tasks.json`;
}

const nowIso = () => new Date().toISOString();

/** Optional collaborators for the JSON store (FEA-4069). */
export type TaskStoreDeps = {
  /**
   * FEA-4069: the NATIVE local-scheduler registration seam (the `crewd` CLI
   * counterpart to the desktop DB host's wiring). When a task's broker `route`
   * flips to/from `claude-scheduled-tasks`, the store fires
   * `register`/`deregister` to materialize/remove the entry in Claude Code's
   * local `~/.claude/scheduled_tasks.json`, and stamps (or clears) the confirmed
   * {@link NATIVE_OWNER_META_KEY} owner marker the daemon keys its local-run
   * suppression off. Best-effort and fire-and-forget: the seam resolves (never
   * rejects) so a filesystem problem can never wedge the upsert, and the persisted
   * `route` stays authoritative regardless. Omitted ⇒ no native-scheduler wiring
   * (the flip still persists the route, and the task keeps running locally).
   */
  scheduledTasksRegistrar?: ScheduledTasksRegistrar;
  /** Key-free diagnostic log sink (best-effort reconcile failures). */
  log?: (message: string) => void;
};

export class TaskStore implements StorePort {
  readonly path: string;
  private file: StoreFile;
  private readonly scheduledTasksRegistrar?: ScheduledTasksRegistrar;
  private readonly log: (message: string) => void;
  // Tail of the fire-and-forget native-schedule reconciles. `whenReconciled()`
  // awaits it so a caller (the CLI) can observe the stamped/cleared owner marker
  // after an upsert instead of racing the async registration. Never rejects — the
  // reconcile itself swallows and logs its own failures.
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(path: string = defaultStorePath(), deps: TaskStoreDeps = {}) {
    this.path = path;
    this.file = this.read();
    this.scheduledTasksRegistrar = deps.scheduledTasksRegistrar;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Resolve once every in-flight native-schedule reconcile has settled (the owner
   * marker is stamped/cleared and persisted). Lets the CLI print the CONFIRMED
   * owner after an `add`/`route` rather than racing the async registration. A
   * plain resolve when no native registrar is wired (nothing is ever enqueued).
   */
  whenReconciled(): Promise<void> {
    return this.reconcileTail;
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) {
      return emptyStore();
    }
    try {
      const parsed = storeFileSchema.parse(
        JSON.parse(readFileSync(this.path, "utf8"))
      );
      return parsed;
    } catch (e) {
      throw new Error(
        `Corrupt store at ${this.path}: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  /** Re-read from disk (another process may have mutated it). */
  reload(): void {
    this.file = this.read();
  }

  // ── tasks ──

  listTasks(): ScheduledTask[] {
    return this.file.tasks;
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.file.tasks.find((t) => t.id === id);
  }

  /** Create or replace a task by id. Missing fields get schema defaults. */
  upsertTask(input: TaskUpsert): ScheduledTask {
    // Reject a malformed cron at write time: an invalid expression would persist
    // silently, then make `computeNextRun` record `nextRunAt: null` and, worse,
    // throw from `computeDue` inside the daemon tick (guarded there, but a bad
    // row should never reach the store). Fail fast so the CLI/caller sees it.
    if (input.cron !== undefined) {
      const check = validateCron(input.cron);
      if (!check.ok) {
        throw new Error(`invalid cron "${input.cron}": ${check.error}`);
      }
    }
    // Reload before mutating so a concurrent writer's changes (e.g. the CLI
    // editing one task while the long-running daemon holds an older snapshot)
    // are not clobbered by this whole-file write.
    this.reload();
    const id = input.id ?? randomUUID();
    const existing = this.getTask(id);
    const previousRoute = existing?.route;
    const merged = scheduledTaskSchema.parse({
      ...(existing ?? {}),
      ...input,
      id,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    });
    const withNext = { ...merged, nextRunAt: this.computeNextRun(merged) };
    if (existing) {
      this.file.tasks = this.file.tasks.map((t) =>
        t.id === id ? withNext : t
      );
    } else {
      this.file.tasks.push(withNext);
    }
    this.write();
    // FEA-4069: reconcile the NATIVE local scheduler AFTER the in-memory + disk
    // mutation, so the persisted `route` is authoritative even if the writer is a
    // no-op. Fire-and-forget and error-isolated (see `reconcileNativeSchedule`).
    this.reconcileNativeSchedule(previousRoute, withNext);
    return withNext;
  }

  removeTask(id: string): boolean {
    this.reload();
    const removedTask = this.getTask(id);
    this.file.tasks = this.file.tasks.filter((t) => t.id !== id);
    const removed = removedTask !== undefined;
    if (removed) {
      this.write();
      // FEA-4069: a deleted task that was materialized into Claude Code's local
      // scheduled_tasks.json must be removed there too, or it keeps firing with
      // no local task backing it. Reconcile against a synthetic local-cascade
      // target so a native task deregisters and a local task is a no-op, reusing
      // the same best-effort seam as a route flip.
      this.reconcileNativeSchedule(removedTask.route, {
        ...removedTask,
        route: TaskRoute.LocalCascade,
      });
    }
    return removed;
  }

  /**
   * FEA-4069: reconcile the native scheduler on STARTUP, not just on a route
   * flip — the `crewd` CLI counterpart to the desktop store's
   * `reconcileNativeSchedulesOnStartup`. `reconcileNativeSchedule` only fires on
   * an `upsertTask`/`removeTask`, so a daemon booting over a store that already
   * holds enabled `claude-scheduled-tasks` tasks (added in a prior invocation)
   * would run them LOCALLY until the operator happens to edit one: the native
   * entry may be missing (never materialized because the store had no registrar
   * then) and no owner is confirmed. This pass re-materializes every enabled
   * native task at boot so the file is normalized and ownership is re-confirmed
   * (or CLEARED when the write fails, so the daemon takes the task back rather
   * than leaving it running in neither scheduler). Each task is reconciled through
   * the same `reconcileNativeSchedule` path an upsert uses (passing the task's OWN
   * route as the "previous" so an enabled native task re-registers and a disabled
   * one deregisters); it is fire-and-forget and error-isolated per task. A no-op
   * when no native registrar is wired. Called by `crewd start` before the daemon's
   * first tick.
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
   * FEA-4069: reconcile the NATIVE local scheduler (`claude-scheduled-tasks`)
   * with a task's current state — the `crewd` CLI counterpart to the desktop
   * SQLite store's `reconcileNativeSchedule`. Kept behavior-identical so the CLI
   * and desktop hosts confirm/clear native ownership the same way:
   *   - route is `claude-scheduled-tasks` AND `enabled` ⇒ (re)register: a
   *     cron/prompt/recurrence/durability edit — or the initial opt-in —
   *     refreshes the native entry (register is an id-keyed upsert, idempotent).
   *   - route is `claude-scheduled-tasks` AND `!enabled` ⇒ deregister: a disabled
   *     task must be REMOVED from the native file (there is no `enabled` flag to
   *     carry the disabled state), or Claude Code keeps firing it.
   *   - a flip OUT of `claude-scheduled-tasks` ⇒ deregister.
   *   - never was and is not native ⇒ no-op.
   *
   * A create has no prior route; an absent previous is treated as `local-cascade`
   * (the pre-broker default). Fire-and-forget and error-isolated: a filesystem
   * failure only logs and clears the owner marker, so the daemon takes the task
   * back locally rather than leaving it running in neither scheduler — it can
   * never wedge the upsert. A no-op when no native registrar is wired.
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
    const shouldRegister = isNative && task.enabled;
    const shouldDeregister = !shouldRegister && (wasNative || isNative);
    if (!(shouldRegister || shouldDeregister)) {
      return;
    }
    const action = shouldRegister
      ? this.scheduledTasksRegistrar.register(task)
      : this.scheduledTasksRegistrar.deregister(task);
    const settled = action
      .then((result) => {
        // Stamp CONFIRMED native ownership only when a REGISTER was accepted with
        // an owner id — the marker the daemon keys its local-run suppression off.
        // A deregister, a failed register, or an ok-without-owner register all
        // leave NO marker, so the daemon keeps owning the task locally.
        if (shouldRegister && result.ok && result.ownerId) {
          this.stampNativeOwner(task.id, result.ownerId);
        } else {
          this.stampNativeOwner(task.id, undefined);
        }
        if (!result.ok) {
          this.log(
            `native-schedule reconcile for '${task.name}' (${task.id}) → ${task.route}: ${result.note}`
          );
        } else if (shouldRegister && !result.ownerId) {
          // A register that reports success but hands back no owner id cannot be
          // confirmed — the daemon would keep running the task locally while the
          // native scheduler also holds it. A registrar contract violation;
          // surface it rather than silently leaving the task unconfirmed.
          this.log(
            `native-schedule register for '${task.name}' (${task.id}) reported ok with no ownerId; treating as unconfirmed (task stays daemon-owned)`
          );
        }
      })
      .catch((error: unknown) => {
        this.stampNativeOwner(task.id, undefined);
        this.log(
          `native-schedule reconcile for '${task.name}' (${task.id}) threw: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    // Chain onto the tail so `whenReconciled()` can await every in-flight
    // reconcile. The `.then`/`.catch` handlers above swallow `action`'s own
    // outcome, but their bodies call `stampNativeOwner` (which does fs
    // reload/write and can throw synchronously) — a throw there would reject
    // `settled` and, unguarded, the tail, breaking the documented "never rejects"
    // invariant `whenReconciled()` relies on. Guard the tail with a final
    // swallowing `.catch` so a filesystem failure in the stamp can never wedge a
    // caller awaiting the tail.
    this.reconcileTail = this.reconcileTail.then(() =>
      settled.catch((error: unknown) => {
        this.log(
          `native-schedule owner-stamp for '${task.name}' (${task.id}) threw: ${error instanceof Error ? error.message : String(error)}`
        );
      })
    );
  }

  /**
   * FEA-4069: set (or clear) the confirmed native-owner marker under
   * {@link NATIVE_OWNER_META_KEY} in a task's `meta` and persist. The daemon's
   * `hasConfirmedNativeOwner` suppression keys off this marker, not the raw route.
   * Reloads first so an async stamp does not clobber a concurrent CLI edit, and is
   * a no-op if the task was removed while the (async) registration was in flight
   * or the marker is already at the target value.
   */
  private stampNativeOwner(id: string, ownerId: string | undefined): void {
    this.reload();
    const task = this.getTask(id);
    if (!task || task.meta[NATIVE_OWNER_META_KEY] === (ownerId ?? undefined)) {
      return;
    }
    const nextMeta = { ...task.meta };
    if (ownerId === undefined) {
      delete nextMeta[NATIVE_OWNER_META_KEY];
    } else {
      nextMeta[NATIVE_OWNER_META_KEY] = ownerId;
    }
    this.file.tasks = this.file.tasks.map((t) =>
      t.id === id ? { ...t, meta: nextMeta } : t
    );
    this.write();
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask | undefined {
    // Reload so we toggle against the latest persisted task, not a stale
    // snapshot; `upsertTask` reloads again but merges over `existing`, so the
    // fresh read here keeps the un-toggled fields we spread current too.
    this.reload();
    const t = this.getTask(id);
    if (!t) {
      return undefined;
    }
    return this.upsertTask({ ...t, enabled });
  }

  /** Move a task's `lastRunAt` cursor forward to `iso` without recording a run. */
  advanceLastRun(id: string, iso: string): void {
    this.reload();
    let changed = false;
    this.file.tasks = this.file.tasks.map((t) => {
      if (t.id !== id) {
        return t;
      }
      // Never move the cursor backward: a stale/earlier slot must not un-advance
      // a cursor a real local run already pushed ahead.
      if (
        t.lastRunAt &&
        new Date(t.lastRunAt).getTime() >= new Date(iso).getTime()
      ) {
        return t;
      }
      changed = true;
      return { ...t, lastRunAt: iso };
    });
    if (changed) {
      this.write();
    }
  }

  private computeNextRun(t: ScheduledTask): string | null {
    // ISS-4814: a SPENT one-time task has no next run. Before the durable fire
    // cursor, retirement meant `enabled: false`, so the guard above covered it;
    // now a spent task deliberately stays enabled, and without this it would keep
    // advertising the next matching cron slot forever — a slot the fire-once
    // guard in `Daemon.tickOnce` will always refuse.
    if (!t.enabled || hasSpentOneTimeFire(t)) {
      return null;
    }
    try {
      return nextRun(t.cron, new Date(), {
        timezone: t.timezone || undefined,
      }).toISOString();
    } catch {
      return null;
    }
  }

  /** Recompute nextRunAt for every task (called each tick). */
  refreshNextRuns(): void {
    // Reload so a task the CLI added/edited since the tick's initial reload is
    // included and not clobbered by this whole-file rewrite.
    this.reload();
    this.file.tasks = this.file.tasks.map((t) => ({
      ...t,
      nextRunAt: this.computeNextRun(t),
    }));
    this.write();
  }

  // ── runs (history / status surface) ──

  startRun(task: ScheduledTask): RunRecord {
    this.reload();
    const rec = runRecordSchema.parse({
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      status: "running" satisfies RunStatus,
      startedAt: nowIso(),
    });
    this.file.runs.unshift(rec);
    if (this.file.runs.length > MAX_RUN_HISTORY) {
      this.file.runs = this.file.runs.slice(0, MAX_RUN_HISTORY);
    }
    // Stamp the task's lastRun pointer + slot and — ISS-4814 — the durable
    // one-time fire cursor, in the SAME whole-file write as the run record, so a
    // crash can never land between "the run started" and "the one fire is
    // spent". The stamp decision reads the freshly reloaded persisted row (`t`),
    // not the caller's launch-time snapshot, so a concurrent edit is honored.
    this.file.tasks = this.file.tasks.map((t) =>
      t.id === task.id
        ? {
            ...t,
            lastRunAt: rec.startedAt,
            lastRunId: rec.id,
            lastStatus: rec.status,
            // Spending the one fire also retires the SCHEDULE — see the
            // matching stamp in the desktop `SqliteTaskStore`.
            ...(shouldStampFireCursor(t)
              ? { firedAt: rec.startedAt, nextRunAt: null }
              : {}),
          }
        : t
    );
    this.write();
    return rec;
  }

  finishRun(runId: string, patch: Partial<RunRecord>): RunRecord | undefined {
    this.reload();
    let updated: RunRecord | undefined;
    this.file.runs = this.file.runs.map((r) => {
      if (r.id !== runId) {
        return r;
      }
      updated = runRecordSchema.parse({
        ...r,
        ...patch,
        finishedAt: patch.finishedAt ?? nowIso(),
      });
      return updated;
    });
    if (updated) {
      const finalStatus = updated.status;
      this.file.tasks = this.file.tasks.map((t) =>
        t.lastRunId === runId ? { ...t, lastStatus: finalStatus } : t
      );
      this.write();
    }
    return updated;
  }

  listRuns(taskId?: string, limit = 50): RunRecord[] {
    const runs = taskId
      ? this.file.runs.filter((r) => r.taskId === taskId)
      : this.file.runs;
    return runs.slice(0, limit);
  }

  snapshot(): StoreFile {
    return this.file;
  }
}
