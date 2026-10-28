import { type TransactionClient, withDb } from "@repo/database";

/** Bounded so a lock wait that never happens fails the case, not the suite. */
const LOCK_POLL_DEADLINE_MS = 2000;

export type RowLockHolder = {
  /**
   * Resolve true once exactly `count` backends wait behind the holder, directly
   * or behind another waiter in its queue. False when the deadline passes.
   */
  waitForWaiters(count: number): Promise<boolean>;
  /** Commit the holder's transaction, releasing its locks. */
  release(): Promise<void>;
};

/**
 * Open a transaction, run `lock` in it, and keep it open until `release()`.
 *
 * Waiters are counted from THIS holder's backend pid, never database-wide: the
 * integration tier runs files in parallel on one database, so a lock wait in
 * another file must not satisfy or fail this one. A second writer on the same
 * row waits on the first writer's tuple lock, not on the holder, so the count
 * follows `pg_blocking_pids` transitively.
 */
export async function holdRowLock(
  lock: (tx: TransactionClient) => Promise<unknown>
): Promise<RowLockHolder> {
  const released = deferred<void>();
  const holding = deferred<number>();
  const transaction = withDb.tx(
    async (tx) => {
      await lock(tx);
      const [row] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `;
      if (row === undefined) {
        throw new Error("could not read the row-lock holder's backend pid");
      }
      holding.resolve(row.pid);
      await released.promise;
    },
    { timeout: 20_000 }
  );
  const holderPid = await Promise.race([
    holding.promise,
    transaction.then(() => {
      throw new Error("the row-lock holder ended before it held the lock");
    }),
  ]);

  return {
    waitForWaiters: (count) => waitForWaitersBehind(holderPid, count),
    async release() {
      released.resolve();
      await transaction;
    },
  };
}

async function waitForWaitersBehind(
  holderPid: number,
  count: number
): Promise<boolean> {
  const giveUpAt = Date.now() + LOCK_POLL_DEADLINE_MS;
  for (let attempt = 0; attempt < 400 && Date.now() < giveUpAt; attempt += 1) {
    const [row] = await withDb(
      (db) => db.$queryRaw<{ waiters: number }[]>`
        WITH RECURSIVE waiting(pid) AS (
          SELECT a.pid
          FROM pg_stat_activity a
          WHERE ${holderPid}::int = ANY(pg_blocking_pids(a.pid))
          UNION
          SELECT a.pid
          FROM pg_stat_activity a
          JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        )
        SELECT count(*)::int AS waiters FROM waiting
      `
    );
    if ((row?.waiters ?? 0) === count) {
      return true;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return false;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
