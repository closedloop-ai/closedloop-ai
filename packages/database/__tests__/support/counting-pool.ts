import type { Pool, PoolClient } from "pg";
import { gateDbAcquisitions } from "../../acquisition-budget";

/**
 * Test doubles for the ISS-8431 acquisition budget.
 *
 * The pool is faked because the contract under test is a connection count, not
 * a query result: how many clients one scope may have checked out at once is
 * independent of what the connections are used for. The end-to-end measurement
 * against Postgres and a real Prisma client is the ticket's probe, recorded in
 * the PR.
 */

export type CountingPoolState = {
  inFlight: number;
  peak: number;
  handedOut: number;
};

export type CountingPool = {
  pool: Pool;
  state: CountingPoolState;
  /** Simulate pg destroying a client instead of it being released. */
  removeClient: (client: PoolClient) => void;
  /** Make the next acquisition reject, as a failed handshake does. */
  failNext: (error: Error) => void;
};

export function createCountingPool(): CountingPool {
  const state: CountingPoolState = { inFlight: 0, peak: 0, handedOut: 0 };
  let removeListener: ((client: PoolClient) => void) | undefined;
  let pendingError: Error | undefined;

  const connect = async (): Promise<PoolClient> => {
    if (pendingError) {
      const error = pendingError;
      pendingError = undefined;
      await Promise.resolve();
      throw error;
    }
    state.inFlight += 1;
    state.handedOut += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await Promise.resolve();
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          state.inFlight -= 1;
        }
      },
    } as unknown as PoolClient;
  };

  const pool = {
    connect,
    on: (event: string, listener: (client: PoolClient) => void) => {
      if (event === "remove") {
        removeListener = listener;
      }
      return pool;
    },
  };

  gateDbAcquisitions(pool as unknown as Pool);

  return {
    pool: pool as unknown as Pool,
    state,
    removeClient: (client) => removeListener?.(client),
    failNext: (error) => {
      pendingError = error;
    },
  };
}

/**
 * One relation-bearing read: the parent query plus one child per relation edge,
 * all started in the same tick — the shape Prisma 7 produces for a
 * non-transactional `findMany` with `include`.
 *
 * Each child acquires, runs and releases on its own, which is what `pool.query`
 * does and therefore what every Prisma child query does. The children never hold
 * each other's connections; a caller that DID hold them all is the one shape
 * that can starve a budget, and `acquisition-budget.test.ts` covers it
 * separately.
 */
export async function readWithRelations(
  pool: Pool,
  relationEdges: number
): Promise<void> {
  await Promise.all(
    Array.from({ length: relationEdges + 1 }, async () => {
      const client = await pool.connect();
      await Promise.resolve();
      client.release();
    })
  );
}

/**
 * A pool that hands out clients through pg's CALLBACK API.
 *
 * Faithful to pg on the one detail the gate depends on: pg builds a single
 * `released` function per checkout, assigns it to `client.release` AND passes it
 * to the callback as `done`, so at callback time the two are the same function.
 * A wrapper that replaces `client.release` therefore does NOT change the `done`
 * the consumer already holds — which is exactly the leak the gate has to close.
 */
export function createCallbackCountingPool(): {
  pool: Pool;
  state: CountingPoolState;
} {
  const state: CountingPoolState = { inFlight: 0, peak: 0, handedOut: 0 };

  const pool = {
    on: () => pool,
    connect: (cb?: PoolConnectCallback) => {
      state.inFlight += 1;
      state.handedOut += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      let released = false;
      const client = {} as PoolClient;
      const done = () => {
        if (!released) {
          released = true;
          state.inFlight -= 1;
        }
      };
      (client as { release: unknown }).release = done;
      queueMicrotask(() => cb?.(undefined, client, done));
    },
  };

  gateDbAcquisitions(pool as unknown as Pool);

  return { pool: pool as unknown as Pool, state };
}

type PoolConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void
) => void;

/** One callback-style checkout, released the documented way — through `done`. */
export function acquireAndReleaseViaDone(pool: Pool): Promise<void> {
  return new Promise((resolve, reject) => {
    (pool.connect as unknown as (cb: PoolConnectCallback) => void)(
      (err, _client, done) => {
        if (err) {
          reject(err);
          return;
        }
        done();
        resolve();
      }
    );
  });
}
