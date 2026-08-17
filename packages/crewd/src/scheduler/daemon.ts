/**
 * The tick loop — the portable replacement for every launchd plist. Wakes on an
 * interval, fires due tasks (non-blocking: a long pass does not stall the loop),
 * and records every run. `dispatch` is injected so the scheduler core stays pure
 * and testable; the default dispatch (see dispatch.ts) wires in the cascade.
 */
import type {
  CascadeAttempt,
  CascadeStep,
  HarnessName,
  RunStatus,
  ScheduledTask,
} from "../model.js";
import {
  hasConfirmedNativeOwner,
  hasSpentOneTimeFire,
  shouldStampFireCursor,
} from "../model.js";
import { computeDue, prevRun } from "./cron.js";
import { type LockPort, noopLock } from "./lock-port.js";
import type { StorePort } from "./store-port.js";

export type DispatchOutcome = {
  status: RunStatus;
  harnessUsed: HarnessName | null;
  attempts: CascadeAttempt[];
  summary: string;
  error: string | null;
  /**
   * Optional pointer to a durable artifact this run produced (e.g. the findings
   * file a review pass wrote). Persisted onto the `RunRecord.logPath` so `crewd
   * runs` can surface where the run's output landed. Omitted when the run
   * produced no artifact.
   */
  logPath?: string | null;
};

export type DispatchContext = {
  defaultCascade: readonly CascadeStep[];
  log: (msg: string) => void;
};

export type Dispatch = (
  task: ScheduledTask,
  ctx: DispatchContext
) => Promise<DispatchOutcome>;

export type DaemonConfig = {
  defaultCascade: readonly CascadeStep[];
  intervalMs?: number;
  /**
   * Advisory path for the CLI's single-instance file lock. The daemon core no
   * longer touches the filesystem — the CLI reads this to build a `FileLock`
   * (see file-lock.ts) and injects it via `DaemonDeps.lock`.
   */
  lockPath?: string;
};

export type DaemonDeps = {
  store: StorePort;
  dispatch: Dispatch;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Single-instance guard acquired in `start()` / released in `stop()`. */
  lock?: LockPort;
};

export type TickReport = {
  due: string[];
  launched: string[];
  now: string;
};

export class Daemon {
  private readonly store: StorePort;
  private readonly dispatch: Dispatch;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly config: DaemonConfig;
  private readonly lock: LockPort;
  private readonly inflight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: DaemonDeps, config: DaemonConfig) {
    this.store = deps.store;
    this.dispatch = deps.dispatch;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.lock = deps.lock ?? noopLock;
    this.config = config;
  }

  /**
   * One scheduler pass. Launches due tasks without awaiting their completion.
   * Async by contract (the daemon's public tick surface) even though the tick
   * body itself is synchronous — callers and `start()` treat it as a promise.
   */
  // biome-ignore lint/suspicious/useAwait: async by contract; the tick body is synchronous by design (launches are fire-and-forget).
  async tickOnce(): Promise<TickReport> {
    this.store.reload();
    const now = this.now();
    const due: string[] = [];
    const launched: string[] = [];

    for (const task of this.store.listTasks()) {
      if (!task.enabled) {
        continue;
      }
      // Fire-once guard (ISS-4814): a one-time (`recurring: false`) task whose
      // durable fire cursor is stamped already had its single fire STARTED, so it
      // must never launch again — including after a crash between the launch and
      // the run's terminal bookkeeping. `lastRunAt` cannot carry this: it only
      // makes `computeDue` skip the CURRENT slot, so a restarted daemon would
      // happily re-fire the task at the next matching slot. A recurring task, and
      // a version-skewed row with `firedAt` absent (hydrating to null), are
      // untouched.
      if (hasSpentOneTimeFire(task)) {
        continue;
      }
      // Ownership guard (FEA-3912 / FEA-3816 / FEA-3958): a task whose local
      // execution is owned by a CONFIRMED native scheduler — a Claude cloud
      // routine (`claude-routine`) OR Claude Code's local scheduled_tasks.json
      // (`claude-scheduled-tasks`) — must NOT also fire locally, or every slot
      // double-executes (once locally, once natively). We key off
      // `hasConfirmedNativeOwner` — a native route AND the owning registrar
      // stamped a confirmed owner id — NOT the raw `route`: a task the operator
      // flipped to a native route whose registration failed or is unwired (the
      // registrar reports `ok:false`) has NO confirmed owner, so suppressing it
      // here would leave it running nowhere. Such a task keeps running locally
      // until ownership is actually confirmed. When ownership IS confirmed we
      // still advance the local `lastRunAt` cursor to the current slot so a later
      // flip back to local-cascade does not `catchUp`-replay a slot the native
      // scheduler already ran.
      if (hasConfirmedNativeOwner(task)) {
        this.advanceNativeSlot(task, now);
        continue;
      }
      // Per-task guard: a persisted task with a malformed cron makes
      // `computeDue` → cron-parser throw. Isolate it so one bad row cannot abort
      // the whole tick and starve later valid tasks. (New rows are rejected at
      // write time by `TaskStore.upsertTask`; this defends pre-existing rows.)
      let decision: ReturnType<typeof computeDue>;
      try {
        decision = computeDue({
          taskId: task.id,
          cron: task.cron,
          now,
          lastRunAt: task.lastRunAt ? new Date(task.lastRunAt) : null,
          catchUp: task.catchUp,
          timezone: task.timezone || undefined,
        });
      } catch (e) {
        this.log(
          `skip ${task.name}: invalid cron "${task.cron}" — ${e instanceof Error ? e.message : String(e)}`
        );
        continue;
      }
      if (!decision.due) {
        continue;
      }
      due.push(task.id);
      if (this.inflight.has(task.id)) {
        this.log(`skip ${task.name}: previous run still in flight`);
        continue;
      }
      this.launch(task);
      launched.push(task.id);
    }

    this.store.refreshNextRuns();
    return { due, launched, now: now.toISOString() };
  }

  private launch(task: ScheduledTask): void {
    // ISS-4814: `startRun` persists the launch record AND — for a one-time task
    // that has not fired yet — the durable fire cursor in the SAME write, so the
    // "run started but task not yet retired" crash window the old
    // retire-on-completion path left open no longer exists.
    const rec = this.store.startRun(task);
    const ctx: DispatchContext = {
      defaultCascade: this.config.defaultCascade,
      log: this.log,
    };
    const p = (async () => {
      try {
        // ISS-4814: BLOCK the dispatch until that launch write is durable. The
        // stamp being folded into `startRun`'s write is only half the barrier —
        // the desktop `SqliteTaskStore` satisfies the synchronous `StorePort`
        // contract from an in-memory mirror and mirrors to SQLite through an
        // unawaited write-behind, so `startRun` returning proves nothing about
        // what survives a kill. Dispatching first would leave the exact window
        // this issue exists to close: process killed after the harness was
        // launched but before the cursor reached SQLite, restarted daemon sees no
        // cursor, task fires a second time. Waiting here inverts that ordering —
        // by the time anything is dispatched the cursor is committed, and a kill
        // BEFORE it commits means nothing ran, so re-firing on restart is correct
        // rather than duplicate. Optional call (see `StorePort.whenRunDurable`):
        // a synchronously-durable or older store just dispatches immediately.
        await this.store.whenRunDurable?.(rec.id);
        // Run the legacy-adapter fallback AFTER the durable point, so it reads
        // settled state, and still BEFORE dispatch, so either retirement path is
        // in place before the harness can produce a side effect.
        this.confirmOneTimeFireRecorded(task);
        const outcome = await this.dispatch(task, ctx);
        this.store.finishRun(rec.id, {
          status: outcome.status,
          harnessUsed: outcome.harnessUsed,
          attempts: outcome.attempts,
          summary: outcome.summary,
          error: outcome.error,
          ...(outcome.logPath == null ? {} : { logPath: outcome.logPath }),
        });
        this.log(
          `done ${task.name}: ${outcome.status}${outcome.harnessUsed ? ` via ${outcome.harnessUsed}` : ""}`
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.store.finishRun(rec.id, { status: "failed", error });
        this.log(`error ${task.name}: ${error}`);
      } finally {
        // Clear the in-flight guard in a `finally` so a throwing
        // `store.finishRun` (a read-only-file or out-of-disk file-backed store,
        // or any rejecting `StorePort` adapter) cannot leave the task
        // permanently guarded as in flight — every later tick would otherwise
        // see it as still running and never re-launch it.
        this.inflight.delete(task.id);
      }
    })().catch((e) => {
      // The launch is fire-and-forget (`tickOnce` does not await it), so a store
      // that throws from BOTH the success and failure `finishRun` calls would
      // surface as an unhandled rejection and kill the daemon process. Log and
      // swallow: the run's bookkeeping is lost, but the scheduler keeps ticking.
      this.log(
        `record ${task.name} FAILED: ${e instanceof Error ? e.message : String(e)}`
      );
    });
    this.inflight.set(task.id, p);
  }

  /**
   * ISS-4814 — verify the one-time fire cursor actually landed, and fall back to
   * the pre-ISS-4814 retirement (disable) when it did not.
   *
   * The fire-once authority is the durable `firedAt` cursor that
   * `StorePort.startRun` stamps atomically with the launch record; both in-repo
   * stores do that, so this is a no-op for them. A `StorePort` adapter built
   * against the older contract (version skew) records the run without stamping
   * the cursor, which would let the task re-fire at a later slot — so when the
   * cursor is still absent right after `startRun`, retire the task the legacy way
   * by disabling it. That happens at run START, not on completion, so either path
   * closes the crash window.
   *
   * Re-reads the LATEST persisted row rather than the launch-time snapshot, so a
   * concurrent `recurring: false → true` edit is not clobbered, and a task deleted
   * mid-launch (`undefined`) is left alone. Any persist failure is caught and
   * logged: it must never reject the fire-and-forget launch promise.
   */
  private confirmOneTimeFireRecorded(task: ScheduledTask): void {
    if (task.recurring) {
      return;
    }
    try {
      this.store.reload();
      const current = this.store.getTask(task.id);
      // `shouldStampFireCursor` is the SAME predicate `StorePort.startRun` gates
      // its stamp on, so the fallback fires exactly when the store declined to
      // stamp — and, critically, it treats a MISSING `firedAt` key (what a
      // pre-ISS-4814 adapter returns) as "not fired" rather than as a stamped
      // cursor. Checking `firedAt !== null` here instead would read every legacy
      // task as already-spent and silently skip this advertised disable fallback.
      if (!(current && shouldStampFireCursor(current))) {
        return;
      }
      this.store.setEnabled(task.id, false);
      this.log(
        `retire ${task.name}: one-time task fired; store did not stamp a fire cursor, disabled instead`
      );
    } catch (e) {
      // A failed fallback persist (read-only/full file-backed store, or a
      // rejecting adapter) must not escape into `launch` and abort the tick. Log
      // and swallow: the task keeps running, and a later tick may re-fire it —
      // undesirable for a one-time task, but strictly better than a tick that
      // dies before launching every task after this one.
      this.log(
        `retire ${task.name} FAILED: ${e instanceof Error ? e.message : String(e)} — task stays enabled and may re-fire`
      );
    }
  }

  /**
   * A confirmed native scheduler (a Claude cloud routine or Claude Code's local
   * scheduled_tasks.json) already ran (or will run) this slot, so the local
   * daemon skipped it (FEA-3912 / FEA-3958). Advance the local `lastRunAt` cursor
   * to the most recent cron slot at/before `now` so a later flip back to
   * `local-cascade` does not `catchUp`-replay a slot the native scheduler already
   * executed. Only advances when the task is actually due at this tick
   * (`computeDue`), so a not-yet-due native task's cursor is left untouched; a
   * malformed cron is isolated (the tick already guards its own `computeDue`, so
   * mirror that here).
   */
  private advanceNativeSlot(task: ScheduledTask, now: Date): void {
    let due: boolean;
    try {
      due = computeDue({
        taskId: task.id,
        cron: task.cron,
        now,
        lastRunAt: task.lastRunAt ? new Date(task.lastRunAt) : null,
        catchUp: task.catchUp,
        timezone: task.timezone || undefined,
      }).due;
    } catch {
      return;
    }
    if (!due) {
      return;
    }
    const slot = prevRun(task.cron, now, {
      timezone: task.timezone || undefined,
    });
    if (slot) {
      this.store.advanceLastRun(task.id, slot.toISOString());
    }
  }

  /**
   * Fire one task once immediately, off-schedule (the "Run now" action). Runs it
   * through the SAME `startRun` → `dispatch` → `finishRun` path a scheduled tick
   * uses, so the run is recorded and the cascade trail is captured identically —
   * it just skips the `computeDue` gate. A no-op (returns false) when the id is
   * unknown, when a run for that task is already in flight (so a double-click
   * cannot double-fire), when a CONFIRMED native scheduler (a Claude cloud
   * routine or Claude Code's local scheduled_tasks.json) owns the task — "Run
   * now" on a natively-owned task would locally double-fire against the native
   * scheduler, so it is rejected here (the UI routes such a manual fire to the
   * native owner) — or when the task is a SPENT one-time task, so a fire-once
   * task cannot be re-run (ISS-4736 / ISS-4814). "Run now" still fires a
   * manually-DISABLED recurring task: disabling a recurring task is an operator
   * pause, and an explicit manual fire is meant to override that.
   */
  runNow(taskId: string): boolean {
    if (this.inflight.has(taskId)) {
      return false;
    }
    const task = this.store.getTask(taskId);
    if (!task) {
      return false;
    }
    // "Fire exactly once" must hold for the manual path too, so reject a re-run
    // of a one-time task whose fire is spent. Two shapes count as spent:
    //   * ISS-4814: the durable `firedAt` cursor is stamped — the authority, and
    //     the only one that survives a crash mid-run.
    //   * pre-ISS-4814: `recurring: false` AND `!enabled`, the shape an older
    //     build left behind when it retired a one-time task by disabling it.
    //     Kept as a compatibility fallback so a store written by that build does
    //     not become manually re-fireable after an upgrade.
    // Both are keyed on `recurring: false`, so a manually-paused *recurring* task
    // stays manually fireable.
    if (hasSpentOneTimeFire(task) || !(task.recurring || task.enabled)) {
      this.log(
        `runNow ${task.name}: one-time task already fired — manual re-run rejected`
      );
      return false;
    }
    // A confirmed native scheduler owns this task's execution; a local manual
    // fire would double-run it. Reject rather than launch locally.
    if (hasConfirmedNativeOwner(task)) {
      this.log(
        `runNow ${task.name}: owned by a confirmed native scheduler — local run rejected`
      );
      return false;
    }
    this.launch(task);
    return true;
  }

  /** Await every in-flight run (tests / graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }

  start(): void {
    this.lock.acquire();
    // Guard against a non-finite/non-positive interval: `?? 30_000` does not
    // catch NaN, and setInterval(NaN) degenerates to a delay-0 busy loop.
    const configured = this.config.intervalMs;
    const interval =
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
        ? configured
        : 30_000;
    const spin = () => {
      this.tickOnce().catch((e) =>
        this.log(`tick error: ${e instanceof Error ? e.message : e}`)
      );
    };
    spin();
    this.timer = setInterval(spin, interval);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    await this.drain();
    this.lock.release();
  }
}
