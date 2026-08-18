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

export function createWriteQueue(): WriteQueue {
  // Two class-scoped FIFO sub-queues. A ready task is served from these by the
  // bounded weighted round-robin in `pump`; tasks still run ONE-AT-A-TIME.
  const interactiveQueue: QueuedTask[] = [];
  const bulkQueue: QueuedTask[] = [];
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
          sharedRun = Promise.resolve().then(fn);
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
                resolve(value);
              }
              advance();
            },
            (error) => {
              if (!record.settled) {
                record.settled = true;
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
          reject(reason);
          if (!record.dispatched) {
            removeTask(record);
            // Not occupying the writer — a slot may now be free to dispatch.
            pump();
          }
        };
      });

      queueFor(record).push(record);
      caller.catch(() => undefined);
      pump();
      return caller;
    },

    cancel(
      token: WriteQueueTaskToken,
      reason: Error = new WriteQueueCancelledError()
    ): WriteQueueCancelOutcome {
      // Target the globally-earliest (by enqueue `seq`) live task owned by
      // `token`, across BOTH class sub-queues AND the running head. Class order
      // is NOT global order — an interactive task can enqueue after an older bulk
      // task, and the running head may predate every queued task — so selecting
      // by `seq` (not interactive-first, not queued-before-running) ensures a
      // per-session timeout evicts the actual wedged write. If the running head
      // is that earliest task (the classic wedge: the timed-out write is the one
      // holding the writer), it is the one cancelled, not a newer same-token
      // queued task. The running head is spliced out of its sub-queue by `pump`,
      // so it is tracked in `runningTask` and folded into the candidate set here.
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
