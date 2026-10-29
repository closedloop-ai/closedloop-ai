/**
 * @file write-queue.ts
 * @description The desktop store's single-writer serialization queue.
 *
 * SQLite is single-connection for writes, so every `prisma.write(...)` must
 * serialize through ONE queue or a second write opening while another's
 * transaction is live fails with SQLITE_BUSY. `createDesktopPrisma` takes a
 * {@link WriteSerializer} and routes `write(fn)` through it;
 * `openSqliteAgentDatabase` builds the single queue and hands it to the Prisma
 * client.
 *
 * Extracted from `sqlite.ts` so it can be imported WITHOUT pulling that module's
 * electron-dependent boot graph — the Prisma test harness (`prisma-test-utils`'s
 * `openTestPrisma`) reuses this production queue, which keeps those tests (and the
 * conversion contract tests built on them) electron-free.
 *
 * ISS-4710 / ISS-4723 PR3 — TWO-CLASS WRITER FAIRNESS. Tasks still run
 * ONE-AT-A-TIME on the single writer connection (concurrency is unchanged, so the
 * SQLITE_BUSY / split-write / RSS-bound invariants below all still hold) — only
 * the SELECTION ORDER between ready tasks changes. Each task carries a `class`:
 *
 *   - `bulk` — the DATA_REVISION rebuild's thousands of `$transaction`s and the
 *     outbox-clear/enqueue writes: high-volume backfill work.
 *   - `interactive` (the default) — the transcript-commit and
 *     component-invocation hot-path writes that must keep uploading DURING a
 *     rebuild.
 *
 * Strict FIFO across both classes let a first-boot rebuild MONOPOLIZE the writer:
 * the transcript/component lanes' interactive writes queued behind thousands of
 * bulk rebuild writes and uploaded nothing ("0 bytes") for the whole rebuild
 * (ISS-4710). The scheduler is now a BOUNDED weighted round-robin: it serves up to
 * {@link INTERACTIVE_BURST_PER_BULK} ready interactive tasks between each bulk
 * task. The interleave is BOUNDED on purpose (memory safety): bulk work is never
 * starved (one bulk task always runs after at most K interactive), and — because
 * tasks still run strictly one-at-a-time — the fairness change can NEVER raise
 * concurrency or let a bulk write bypass the writer discipline that bounds
 * WAL/RSS. It only reorders which single ready task opens next.
 *
 * ISS-4572 — TASK-SCOPED cancellation (R2 redesign). A historical import write
 * that is genuinely wedged (the DB-host write accepted but never completing) would
 * otherwise park EVERY later source behind it at the head of THIS serialized queue.
 * `importSessionBounded` (ISS-4410) abandons the caller's promise on timeout, but
 * the underlying queued task keeps the writer from advancing.
 *
 * The FIRST cut of this fix evicted whatever task was at the queue HEAD
 * (`cancelActive`), with no binding to the timed-out import. Because ONE queue is
 * shared across the five concurrent boot-import loops and a single import submits
 * many independent `prisma.write` groups, that head could be a DIFFERENT, healthy
 * session's transaction — evicting the wrong victim and orphaning its row. This
 * redesign makes eviction TASK-SCOPED:
 *
 *   - `run(fn, token?, opts?)` tags each task with an opaque owner `token` (the
 *     importer passes the session id). Untagged tasks (live hooks, maintenance)
 *     are never evictable.
 *   - `cancel(token)` evicts ONLY a task owned by that token — the running head if
 *     it matches, else a queued (not-yet-running) task with that token. A head
 *     owned by a different session is left alone. Returns `true` only when a
 *     matching task was actually evicted, so a timeout can never take an unrelated
 *     victim.
 *
 * Split-write safety (R2, codex/stage T1/T3): eviction rejects the CALLER's
 * promise early (so `importSessionBounded` advances), but the queue still chains
 * the NEXT dispatch on the evicted task's underlying `fn`'s REAL settle — never on
 * the early eviction. A successor task therefore does not open its own
 * `$transaction` on the single writer connection until the evicted task's
 * abandoned transaction has actually finished, so a delete-then-reinsert group can
 * never interleave with, or be split by, the abandoned one. (An eviction of a
 * genuinely-hung own transaction still holds the physical connection until it
 * settles — the JS queue cannot force-abort a libSQL transaction, and a
 * writer-connection restart is deliberately out of scope; but because eviction is
 * now task-scoped it only ever blocks on the timed-out session's OWN wedged write,
 * never an unrelated one.)
 */

import { runOutsideStoreReadCancellation } from "./db-host/store-read-cancellation.js";

import type { WriteSerializer } from "./prisma-client.js";

/**
 * ISS-6115: what {@link WriteQueue.cancel} actually did. The boolean it used to
 * return could not tell the two eviction cases apart, and they mean opposite
 * things to a caller deciding whether a source burned its OWN deadline:
 *
 *   - {@link WriteQueueCancelOutcome.Running} — the evicted task had been
 *     DISPATCHED, so this owner's write was the one holding the single writer.
 *     Its deadline was spent on its own work.
 *   - {@link WriteQueueCancelOutcome.Queued} — the evicted task had NOT been
 *     dispatched, so this owner's write never ran at all: every millisecond of
 *     its deadline was spent waiting behind a DIFFERENT owner's transaction.
 *
 * This is the same distinction the ISS-4572 parse bound draws with its
 * dispatch-scoped clock, and the same one `createImportGroupWriter` (ISS-6003)
 * already draws per record group — a waiter must never be charged for the queue.
 */
export const WriteQueueCancelOutcome = {
  /** No live task owned by the token was queued or running. */
  None: "none",
  /** Evicted a task that had NOT been dispatched — it never held the writer. */
  Queued: "queued",
  /** Evicted the dispatched task — this owner's own write was in flight. */
  Running: "running",
} as const;
export type WriteQueueCancelOutcome =
  (typeof WriteQueueCancelOutcome)[keyof typeof WriteQueueCancelOutcome];

/** The error a cancelled (evicted) write-queue task rejects with. */
export class WriteQueueCancelledError extends Error {
  constructor(message = "write-queue task evicted") {
    super(message);
    this.name = "WriteQueueCancelledError";
  }
}

/**
 * Opaque owner identity for an evictable task. The importer passes the session id
 * so `cancel(token)` can target exactly that session's queued/in-flight write.
 */
export type WriteQueueTaskToken = string;

/**
 * ISS-7256: where an owner's earliest live write stands relative to the writer.
 *
 * Three states rather than a boolean because a caller charging a retry budget
 * has to tell "waiting behind someone else" from "not at the writer at all", and
 * a boolean collapses the second into the first. {@link Absent} is the state the
 * ISS-6115 eviction already reported as {@link WriteQueueCancelOutcome.None},
 * and it keeps that meaning here: an owner doing its own pre-queue work (parse,
 * attribution) or already past its write is NOT a waiter.
 */
export const WriteDispatchState = {
  /** The owner's earliest live task is queued and has never dispatched. */
  Queued: "queued",
  /** That task has dispatched — this owner's own write holds (or held) the writer. */
  Dispatched: "dispatched",
  /** The owner owns no live task here, so it is not waiting on the writer. */
  Absent: "absent",
} as const;
export type WriteDispatchState =
  (typeof WriteDispatchState)[keyof typeof WriteDispatchState];

/**
 * ISS-7256: the read-only answer to "has this owner's write dispatched?", plus
 * the identity of the task the answer is ABOUT.
 *
 * `taskSeq` is that task's global enqueue order ({@link QueuedTask.seq}), or
 * `null` when the owner owns nothing live. It exists because this answer is
 * consumed asynchronously — in DB-host mode a whole IPC round trip after it was
 * computed — and a bare `queued` cannot be told apart across two probes: an
 * owner whose task dispatched, settled, and was followed by the NEXT record
 * group's task reads `queued` both times while having made a full write's worth
 * of progress in between. A changed `taskSeq` is that progress, so a caller can
 * refuse to treat the second answer as "still waiting on the same thing".
 */
export type WriteDispatchProbe = {
  state: WriteDispatchState;
  taskSeq: number | null;
};

/**
 * ISS-7256: a write-queue lifecycle transition for a TOKENED task.
 *
 * Untokened tasks (live hooks, maintenance) are deliberately not reported: they
 * are not addressable by `cancel` either, so nothing can ask about them.
 */
export const WriteQueueTaskPhase = {
  /** Enqueued, not yet selected. */
  Queued: "queued",
  /** Selected by `pump`; its `fn` is about to run. */
  Dispatched: "dispatched",
  /** Done, errored, or evicted. */
  Settled: "settled",
} as const;
export type WriteQueueTaskPhase =
  (typeof WriteQueueTaskPhase)[keyof typeof WriteQueueTaskPhase];

/**
 * ISS-7256: observe tokened-task transitions as they happen.
 *
 * The queue lives on the store thread, one hop from the dispatcher that has to
 * answer for it while that thread is blocked inside a synchronous statement. A
 * PULL (`probeUndispatchedTask` over IPC) cannot be answered in that window by
 * construction — the thread that holds the queue is the thread that is blocked —
 * so the state has to have been PUSHED out before the block began. This is that
 * push; `write-dispatch-mirror.ts` is the dispatcher-side mirror it feeds.
 *
 * Fires SYNCHRONOUSLY at the transition, for the same ordering reason
 * {@link withCommittedWriteObserver} does: a notice posted after the fact is a
 * notice the blocked window does not have.
 */
export type WriteQueueTaskObserver = (
  token: WriteQueueTaskToken,
  phase: WriteQueueTaskPhase,
  taskSeq: number
) => void;

/**
 * ISS-4710 fairness class for a queued write. `bulk` is backfill/rebuild volume
 * work; `interactive` (the default) is the hot-path transcript/component writes
 * that must keep making progress DURING a bulk rebuild.
 */
export const WriteQueueClass = {
  Bulk: "bulk",
  Interactive: "interactive",
} as const;
export type WriteQueueClass =
  (typeof WriteQueueClass)[keyof typeof WriteQueueClass];

/** Per-task options for {@link WriteQueue.run}. */
export type WriteQueueRunOptions = {
  /**
   * Fairness class (default {@link WriteQueueClass.Interactive}). Tag the
   * DATA_REVISION rebuild + outbox bulk writes `bulk` so the weighted round-robin
   * lets interactive transcript/component writes interleave rather than queue
   * behind the whole rebuild.
   */
  class?: WriteQueueClass;
};

export type WriteQueue = {
  /**
   * Enqueue `fn`; it runs once it is SELECTED and every prior selected task has
   * settled (or been evicted, whose REAL settle the queue still waits on).
   * Rejects with a {@link WriteQueueCancelledError} (or the supplied reason) if
   * this task is evicted by {@link cancel} while it is queued or the running head.
   *
   * `token` tags the task with its owner so {@link cancel} can target it. Omit it
   * for writes that must never be evicted (live hooks, maintenance) — an untagged
   * task is invisible to `cancel`.
   *
   * `opts.class` (ISS-4710) picks the fairness class. Tasks still run strictly
   * one-at-a-time; the class only changes the SELECTION order among ready tasks
   * (bounded weighted round-robin — see {@link INTERACTIVE_BURST_PER_BULK}).
   */
  run<T>(
    fn: () => Promise<T>,
    token?: WriteQueueTaskToken,
    opts?: WriteQueueRunOptions
  ): Promise<T>;
  /**
   * ISS-4572 (task-scoped): evict the task OWNED by `token` — a queued task with
   * that token, else the running head if it matches — so the writer advances
   * (once the underlying work truly settles) and later writes proceed. Rejects the
   * evicted task's caller promise with `reason` (default
   * {@link WriteQueueCancelledError}). A no-op ({@link WriteQueueCancelOutcome.None})
   * when no task owned by `token` is queued or running — including when the running
   * head belongs to a DIFFERENT owner, which is exactly how a per-session timeout
   * avoids taking a wrong victim.
   *
   * ISS-6115: reports WHICH eviction happened, because `queued` (never dispatched,
   * so the owner only ever waited behind someone else) and `running` (this owner's
   * own write held the writer) mean opposite things to a caller charging a retry
   * budget. See {@link WriteQueueCancelOutcome}.
   */
  cancel(token: WriteQueueTaskToken, reason?: Error): WriteQueueCancelOutcome;
  /**
   * ISS-7256: is `token`'s earliest live task only WAITING behind another owner's
   * write, or has it dispatched? The read-only counterpart to {@link cancel}'s
   * {@link WriteQueueCancelOutcome.Queued}, which answers the same question but
   * only by evicting the task it asks about.
   *
   * Reports the probed task's {@link WriteDispatchProbe.taskSeq} alongside the
   * state so a caller that acts on the answer LATER can tell a still-waiting task
   * from a different task of the same owner — see that field.
   */
  probeUndispatchedTask(token: WriteQueueTaskToken): WriteDispatchProbe;
  /** Resolve once the queue has fully drained (no queued or running task). */
  drain(): Promise<void>;
};

/**
 * ISS-4710: how many ready `interactive` tasks the scheduler serves between each
 * `bulk` task. Bounds the interleave so bulk rebuild work is never starved (one
 * bulk always runs after at most this many interactive tasks) while the
 * transcript/component hot-path writes still make steady progress during a
 * rebuild. Named constant, not a magic number — memory safety depends on this
 * staying a small BOUND, never unbounded interactive preemption.
 */
const INTERACTIVE_BURST_PER_BULK = 4;

/** Internal per-task record tracked while the task is queued or running. */
type QueuedTask = {
  readonly token: WriteQueueTaskToken | undefined;
  readonly writeClass: WriteQueueClass;
  /**
   * Monotonic global enqueue order (ISS-4710). The class sub-queues each stay
   * FIFO, but a task's class does not tell us its position relative to a task of
   * the OTHER class. `cancel(token)` uses `seq` to pick the globally-earliest
   * live task owned by a token so a per-session timeout evicts the actual wedged
   * write, never a newer same-token task that merely sorts earlier by class.
   */
  readonly seq: number;
  /** Start the underlying `fn` (exactly once) and settle the caller on its result. */
  start: () => void;
  /**
   * Reject the caller's promise (evict). No-ops after the task has already
   * settled (via `fn` or a prior eviction).
   */
  evict: (reason: Error) => void;
  /** True once this task has settled (done, errored, or evicted). */
  settled: boolean;
  /** True once this task has been dispatched (its `fn` may be running). */
  dispatched: boolean;
};

export function createWriteQueue(
  /**
   * ISS-7256: optional transition observer. Absent in the in-process topology and
   * in tests, where `probeUndispatchedTask` answers directly off this closure;
   * the store thread supplies one so the dispatcher can answer for the queue
   * while this thread is blocked. See {@link WriteQueueTaskObserver}.
   */
  observe?: WriteQueueTaskObserver
): WriteQueue {
  // Two class-scoped FIFO sub-queues. A ready task is served from these by the
  // bounded weighted round-robin in `pump`; tasks still run ONE-AT-A-TIME.
  const interactiveQueue: QueuedTask[] = [];
  const bulkQueue: QueuedTask[] = [];

  /**
   * Report a transition, never letting an observer's failure reach the writer.
   * A mirror is a diagnostic the sweep consults; a throw here would abort a real
   * write, which is strictly worse than a stale mirror entry.
   */
  const report = (record: QueuedTask, phase: WriteQueueTaskPhase): void => {
    if (!(observe && record.token !== undefined)) {
      return;
    }
    try {
      observe(record.token, phase, record.seq);
    } catch {
      // A broken observer must never cost a write.
    }
  };
  // The task currently running (its `fn` in flight), or null when the writer is
  // idle. Guarantees the single-writer / split-write invariant: the next task is
  // dispatched only after the running one's REAL settle. Tracked (not just a
  // boolean) so `cancel(token)` can still target the in-flight head, which has
  // already been spliced out of its sub-queue by `pump`.
  let runningTask: QueuedTask | null = null;
  // Monotonic counter stamping each task's global enqueue order (ISS-4710) so
  // `cancel(token)` can select the globally-earliest live task across both class
  // sub-queues and the running head.
  let nextSeq = 0;
  // How many interactive tasks have been served since the last bulk task, so the
  // round-robin can cap the interactive burst at INTERACTIVE_BURST_PER_BULK.
  let interactiveSinceBulk = 0;
  // Resolvers waiting on drain(): settled once both sub-queues are empty AND
  // nothing is running.
  let drainWaiters: Array<() => void> = [];

  const isIdle = (): boolean =>
    runningTask === null &&
    interactiveQueue.length === 0 &&
    bulkQueue.length === 0;

  const settleDrainWaiters = (): void => {
    if (drainWaiters.length > 0 && isIdle()) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  };

  const queueFor = (record: QueuedTask): QueuedTask[] =>
    record.writeClass === WriteQueueClass.Bulk ? bulkQueue : interactiveQueue;

  /**
   * The globally-earliest (by enqueue `seq`) live task owned by `token`, across
   * BOTH class sub-queues AND the running head. Class order is NOT global order —
   * an interactive task can enqueue after an older bulk task, and the running head
   * may predate every queued task — so selecting by `seq` (not interactive-first,
   * not queued-before-running) is what makes a per-session timeout address the
   * actual wedged write. The running head is spliced out of its sub-queue by
   * `pump`, so it is tracked in `runningTask` and folded into the candidate set.
   *
   * Shared by `cancel` and `hasUndispatchedTask` (ISS-7256) so the destructive and
   * read-only answers can never be about different tasks.
   */
  const earliestLiveTaskFor = (
    token: WriteQueueTaskToken
  ): QueuedTask | undefined => {
    let target: QueuedTask | undefined;
    const consider = (t: QueuedTask | null): void => {
      if (!t || t.token !== token || t.settled) {
        return;
      }
      if (!target || t.seq < target.seq) {
        target = t;
      }
    };
    for (const t of interactiveQueue) {
      consider(t);
    }
    for (const t of bulkQueue) {
      consider(t);
    }
    consider(runningTask);
    return target;
  };

  const removeTask = (record: QueuedTask): void => {
    const queue = queueFor(record);
    const idx = queue.indexOf(record);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
  };

  /**
   * Pick the next ready task per the bounded weighted round-robin: prefer
   * interactive until INTERACTIVE_BURST_PER_BULK have run since the last bulk,
   * then serve one bulk (resetting the counter). When only one class has ready
   * work, serve it regardless of the counter so neither class stalls when the
   * other is empty.
   */
  const selectNext = (): QueuedTask | undefined => {
    const hasInteractive = interactiveQueue.length > 0;
    const hasBulk = bulkQueue.length > 0;
    if (hasInteractive && !hasBulk) {
      return interactiveQueue[0];
    }
    if (hasBulk && !hasInteractive) {
      return bulkQueue[0];
    }
    if (!(hasInteractive || hasBulk)) {
      return undefined;
    }
    // Both classes have ready work: burst interactive up to the cap, then a bulk.
    if (interactiveSinceBulk < INTERACTIVE_BURST_PER_BULK) {
      return interactiveQueue[0];
    }
    return bulkQueue[0];
  };

  /**
   * Dispatch the next selected task if the writer is free. Runs exactly one task
   * to completion (real settle) before dispatching the next, so concurrency stays
   * at one — the fairness change reorders selection only, never parallelism.
   */
  const pump = (): void => {
    if (runningTask !== null) {
      return;
    }
    const next = selectNext();
    if (!next) {
      settleDrainWaiters();
      return;
    }
    removeTask(next);
    if (next.writeClass === WriteQueueClass.Bulk) {
      interactiveSinceBulk = 0;
    } else {
      interactiveSinceBulk += 1;
    }
    runningTask = next;
    next.dispatched = true;
    // Reported BEFORE `start`, which is what makes the notice usable: `fn`'s
    // first statement is where a synchronous libSQL call blocks this thread, and
    // a notice posted after that would not reach the dispatcher until the block
    // ended — exactly the window the mirror exists to answer in.
    report(next, WriteQueueTaskPhase.Dispatched);
    next.start();
  };

  return {
    run<T>(
      fn: () => Promise<T>,
      token?: WriteQueueTaskToken,
      opts?: WriteQueueRunOptions
    ): Promise<T> {
      const writeClass = opts?.class ?? WriteQueueClass.Interactive;
      // The single shared execution of `fn`, started when this task is selected.
      // `fn` runs exactly once.
      let sharedRun: Promise<T> | null = null;
      const startFn = (): Promise<T> => {
        if (!sharedRun) {
          // ISS-9802: started OUTSIDE any read-cancellation scope. `pump` selects
          // the next task from inside the previous task's settle continuation,
          // and `AsyncLocalStorage` follows that chain — so without this exit a
          // cancellable read that enqueued a write would seed its own scope into
          // whatever the queue dispatches next, and cancelling that read would
          // throw out of an UNRELATED caller's write at its next checkpoint and
          // lose it. Cancellation may abandon a read; never a write.
          sharedRun = runOutsideStoreReadCancellation(() =>
            Promise.resolve().then(fn)
          );
        }
        return sharedRun;
      };

      const record: QueuedTask = {
        token,
        writeClass,
        seq: nextSeq,
        settled: false,
        dispatched: false,
        start: () => undefined,
        evict: () => undefined,
      };
      nextSeq += 1;

      const caller = new Promise<T>((resolve, reject) => {
        // Called by `pump` once this task is selected: start `fn` and settle the
        // caller on its result unless already evicted. Advance the writer on the
        // underlying `fn`'s REAL settle (never on an early eviction), so the next
        // task cannot open its `$transaction` until this one's actually finished.
        record.start = (): void => {
          const advance = (): void => {
            // The underlying `fn` has truly settled — free the writer (even if the
            // caller was evicted early, this is the abandoned work's REAL settle,
            // which is exactly when the successor may open its transaction).
            if (runningTask === record) {
              runningTask = null;
            }
            pump();
          };
          startFn().then(
            (value) => {
              if (!record.settled) {
                record.settled = true;
                report(record, WriteQueueTaskPhase.Settled);
                resolve(value);
              }
              advance();
            },
            (error) => {
              if (!record.settled) {
                record.settled = true;
                report(record, WriteQueueTaskPhase.Settled);
                reject(
                  error instanceof Error ? error : new Error(String(error))
                );
              }
              advance();
            }
          );
        };
        // Wire eviction: `cancel` calls this to reject the caller early. If the
        // task has NOT been dispatched yet, `fn` never runs and we remove it from
        // its sub-queue so the writer is never occupied by it. If it IS already
        // dispatched (the running head), we only reject the caller early — the
        // real `fn` keeps running and its late settle advances the writer, so the
        // split-write invariant holds.
        record.evict = (reason: Error): void => {
          if (record.settled) {
            return;
          }
          record.settled = true;
          report(record, WriteQueueTaskPhase.Settled);
          reject(reason);
          if (!record.dispatched) {
            removeTask(record);
            // Not occupying the writer — a slot may now be free to dispatch.
            pump();
          }
        };
      });

      queueFor(record).push(record);
      // Reported before `pump`, so a task selected immediately still produces
      // `queued` then `dispatched` in that order rather than only the latter.
      report(record, WriteQueueTaskPhase.Queued);
      caller.catch(() => undefined);
      pump();
      return caller;
    },

    cancel(
      token: WriteQueueTaskToken,
      reason: Error = new WriteQueueCancelledError()
    ): WriteQueueCancelOutcome {
      const target = earliestLiveTaskFor(token);
      if (!target) {
        return WriteQueueCancelOutcome.None;
      }
      // Read `dispatched` BEFORE evicting: it is the whole answer, and eviction
      // is what makes the task unreachable.
      const dispatched = target.dispatched;
      target.evict(reason);
      return dispatched
        ? WriteQueueCancelOutcome.Running
        : WriteQueueCancelOutcome.Queued;
    },

    probeUndispatchedTask(token: WriteQueueTaskToken): WriteDispatchProbe {
      const target = earliestLiveTaskFor(token);
      if (!target) {
        return { state: WriteDispatchState.Absent, taskSeq: null };
      }
      return {
        state: target.dispatched
          ? WriteDispatchState.Dispatched
          : WriteDispatchState.Queued,
        taskSeq: target.seq,
      };
    },

    drain(): Promise<void> {
      if (isIdle()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
  };
}

/**
 * ISS-7110: a `WriteSerializer` view of `queue` whose tasks call `notify` after
 * their underlying work resolves. Wrapping the TASK (not the caller promise)
 * means the observer fires on the write's real successful settle — including an
 * ISS-4572-evicted task whose transaction still committed — and never for a
 * write that rejected.
 *
 * `notify` must never fail a committed write, in either direction the type
 * cannot rule out: a synchronous throw is swallowed, and — because structural
 * typing lets an async function satisfy `() => void` — a returned promise gets
 * a no-op `catch` so its rejection can never float into this process's
 * exit-on-unhandledRejection crash path (db-host-memory-watchdog.ts).
 */
export function withCommittedWriteObserver(
  queue: WriteQueue,
  notify: () => void
): WriteSerializer {
  const notifySafely = (): void => {
    try {
      swallowRejection(notify());
    } catch {
      // Synchronous observer throw — the write already committed.
    }
  };
  return {
    run: (fn, token, opts) =>
      queue.run(
        async () => {
          const value = await fn();
          notifySafely();
          return value;
        },
        token,
        opts
      ),
  };
}

/** Absorb the rejection of a promise an `() => void` callback smuggled back. */
function swallowRejection(value: unknown): void {
  if (value instanceof Promise) {
    value.catch(() => undefined);
  }
}
