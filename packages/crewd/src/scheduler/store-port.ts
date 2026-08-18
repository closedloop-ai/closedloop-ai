/**
 * StorePort — the storage seam the scheduler core depends on.
 *
 * This is the architectural keystone of FEA-3812: the daemon and every pass
 * talk to this INTERFACE, never to a concrete store. The JSON/file-backed
 * `TaskStore` (see store.ts) implements it for the CLI, and a SQLite-backed
 * implementation can back it inside apps/desktop later (FEA-3813) without the
 * core taking on any `node:fs` coupling.
 *
 * Keep this file transport-neutral: it imports only the serializable model
 * shapes, no Node/fs types. That is what lets the exported core (`Daemon`,
 * `cascade`, `model`, `StorePort`) be imported by the desktop renderer verbatim.
 */
import type { RunRecord, ScheduledTask, StoreFile } from "../model.js";

/** A task upsert payload — `name` and `cron` are required; the rest default. */
export type TaskUpsert = Partial<ScheduledTask> & {
  id?: string;
  name: string;
  cron: string;
};

/**
 * The full storage contract. Read/write of tasks and the bounded run-history
 * ring, plus the scheduler-facing lifecycle calls the daemon uses each tick.
 */
export type StorePort = {
  // ── tasks ──
  listTasks(): ScheduledTask[];
  getTask(id: string): ScheduledTask | undefined;
  /** Create or replace a task by id. Missing fields get schema defaults. */
  upsertTask(input: TaskUpsert): ScheduledTask;
  removeTask(id: string): boolean;
  setEnabled(id: string, enabled: boolean): ScheduledTask | undefined;
  /** Recompute `nextRunAt` for every task (called each tick). */
  refreshNextRuns(): void;
  /**
   * Advance a task's local scheduling cursor (`lastRunAt`) to `iso` WITHOUT
   * recording a run (FEA-3912). Used when a confirmed Claude cloud routine ran a
   * slot: the local daemon did not fire the task, but the local cursor must move
   * to the slot the cloud ran so a later flip back to `local-cascade` does not
   * `catchUp`-replay a slot that already executed in the cloud. A no-op when the
   * cursor is already at or past `iso` (never moves backward) or the id is
   * unknown. Distinct from `startRun` because no run history row is created.
   */
  advanceLastRun(id: string, iso: string): void;

  // ── runs (history / status surface) ──
  startRun(task: ScheduledTask): RunRecord;
  /**
   * ISS-4814 — resolves once the writes `startRun(runId)` issued (the launch
   * record AND the one-time fire cursor stamped alongside it) are DURABLE in the
   * backing store, not merely applied to an in-memory mirror.
   *
   * The daemon awaits this before it dispatches, which is what makes the fire
   * cursor a real crash barrier: a store that mirrors to disk through an
   * unawaited write-behind (the desktop `SqliteTaskStore`) would otherwise let a
   * kill land after dispatch began but before the cursor reached SQLite, and the
   * restarted daemon would see no cursor and re-fire a task that already ran. A
   * kill BEFORE this resolves is safe by construction: nothing was dispatched, so
   * re-firing on restart is the correct at-least-once outcome rather than a
   * duplicate fire.
   *
   * OPTIONAL, and additive on purpose (version skew): a store whose mutations are
   * already durable when `startRun` returns — the file-backed `TaskStore` writes
   * synchronously — simply omits it, and an adapter built against the older
   * contract has no such method. The daemon calls it optionally and degrades to
   * the previous immediate-dispatch behavior. Must never reject; a failed durable
   * write resolves (logged by the store) so a broken mirror cannot wedge the
   * scheduler. Resolves immediately for an unknown/already-settled `runId`.
   */
  whenRunDurable?(runId: string): Promise<void>;
  finishRun(runId: string, patch: Partial<RunRecord>): RunRecord | undefined;
  listRuns(taskId?: string, limit?: number): RunRecord[];

  // ── lifecycle ──
  /** Re-read from the backing store (another process may have mutated it). */
  reload(): void;
  /** A serializable snapshot of the whole store (tasks + runs). */
  snapshot(): StoreFile;
};
