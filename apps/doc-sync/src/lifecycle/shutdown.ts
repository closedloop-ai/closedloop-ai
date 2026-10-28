import { log } from "@repo/observability/log";
import { flushLogsWithDeadline } from "@repo/observability/shutdown";

export const SHUTDOWN_DEADLINE_EXCEEDED_EVENT =
  "doc_sync.shutdown_deadline_exceeded";
export const SHUTDOWN_FAILED_EVENT = "doc_sync.shutdown_failed";

export type ShutdownDeps = {
  /**
   * Hocuspocus `Server.destroy()`: closes the HTTP server and every
   * connection, flushes pending stores, and resolves once every document has
   * unloaded.
   */
  destroy: () => Promise<void>;
  /** Stops the gauge reporter's timer; runs first. */
  stopGauges?: () => void;
  /**
   * Releases storage (the Postgres pool) once `destroy()` has resolved or its
   * share of the deadline has passed. It runs inside that same share, so it
   * never eats into the log flush's reserve.
   */
  closeStorage?: () => Promise<void>;
  /**
   * Sends the change callbacks still queued, given what is left of destroy's
   * share. It runs last in that share, after the final stores `destroy()`
   * makes have enqueued theirs.
   */
  flushCallbacks?: (deadlineMs: number) => Promise<void>;
  /** The whole shutdown's budget: `destroy()`, `closeStorage()`, `flushCallbacks()` and the log flush share it. */
  deadlineMs: number;
  flushLogs?: (deadlineMs: number) => Promise<void>;
  now?: () => number;
};

/**
 * Every call returns the first call's promise. `destroy()`, `closeStorage()`
 * and `flushCallbacks()`, in that order, share the budget minus a reserve for
 * the log flush, and the log flush gets whatever is left, so neither a stalled
 * store nor a stalled log intake can carry the shutdown past `deadlineMs`.
 */
export function createShutdown({
  destroy,
  stopGauges,
  closeStorage,
  flushCallbacks,
  deadlineMs,
  flushLogs = flushLogsWithDeadline,
  now = Date.now,
}: ShutdownDeps): () => Promise<void> {
  let inFlight: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    stopGauges?.();
    const startedAt = now();
    const destroyMs = destroyBudgetMs(deadlineMs);
    const stage = (
      step: ShutdownStep,
      work: (remainingMs: number) => Promise<void>
    ) => {
      const remainingMs = Math.max(0, destroyMs - (now() - startedAt));
      return runStage(step, () => work(remainingMs), {
        deadlineMs,
        destroyMs,
        remainingMs,
      });
    };
    await stage(ShutdownStep.Destroy, destroy);
    if (closeStorage) {
      await stage(ShutdownStep.CloseStorage, closeStorage);
    }
    if (flushCallbacks) {
      await stage(ShutdownStep.FlushCallbacks, flushCallbacks);
    }
    await flushLogs(Math.max(0, deadlineMs - (now() - startedAt)));
  };

  return () => {
    inFlight ??= run();
    return inFlight;
  };
}

/** The share of `deadlineMs` that `destroy()` may use; the rest is kept for the log flush. */
export function destroyBudgetMs(deadlineMs: number): number {
  return (
    deadlineMs - Math.min(LOG_FLUSH_RESERVE_MAX_MS, Math.floor(deadlineMs / 4))
  );
}

const LOG_FLUSH_RESERVE_MAX_MS = 5000;

export const ShutdownStep = {
  Destroy: "destroy",
  CloseStorage: "close_storage",
  FlushCallbacks: "flush_callbacks",
} as const;
type ShutdownStep = (typeof ShutdownStep)[keyof typeof ShutdownStep];

/** Runs one step within what is left of destroy's share; a miss or a throw is logged, never rethrown. */
async function runStage(
  step: ShutdownStep,
  work: () => Promise<void>,
  budget: { deadlineMs: number; destroyMs: number; remainingMs: number }
): Promise<void> {
  try {
    const outcome = await raceDeadline(work(), budget.remainingMs);
    if (outcome === DestroyOutcome.DeadlineExceeded) {
      log.error("Doc sync shutdown deadline exceeded", {
        event: SHUTDOWN_DEADLINE_EXCEEDED_EVENT,
        step,
        deadlineMs: budget.deadlineMs,
        destroyMs: budget.destroyMs,
      });
    }
  } catch (error) {
    log.error("Doc sync shutdown failed", {
      event: SHUTDOWN_FAILED_EVENT,
      step,
      error,
    });
  }
}

const DestroyOutcome = {
  Destroyed: "destroyed",
  DeadlineExceeded: "deadline_exceeded",
} as const;
type DestroyOutcome = (typeof DestroyOutcome)[keyof typeof DestroyOutcome];

function raceDeadline(
  destroyed: Promise<void>,
  deadlineMs: number
): Promise<DestroyOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DestroyOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve(DestroyOutcome.DeadlineExceeded),
      deadlineMs
    );
  });
  return Promise.race([
    destroyed.then(() => DestroyOutcome.Destroyed),
    deadline,
  ]).finally(() => clearTimeout(timer));
}
