import { gateDbAcquisitions } from "@repo/database/acquisition-budget";
import type { Pool, PoolClient } from "pg";

/**
 * Test doubles for the ISS-8431 acquisition budget, shared by every `apps/api`
 * suite that asserts a bound in CONNECTIONS rather than in calls.
 *
 * The pool is faked because the contract under test is a connection count, not
 * a query result: how many clients one scope may have checked out at once is
 * independent of what the connections are used for. The end-to-end measurement
 * against Postgres and a real Prisma client is the ticket's probe, recorded in
 * the PR.
 *
 * Deliberately a local copy of `packages/database/__tests__/support/counting-pool.ts`
 * rather than a shared import: this repo has no cross-package test-fixture
 * subpath, and adding one to a package that ships inside the `apps/mcp` and
 * `apps/relay` Docker contexts is a larger change than the duplication is worth.
 * Within `apps/api` there is exactly one copy, which is this file.
 */

export type CountingPoolState = { inFlight: number; peak: number };

export function createCountingPool(): {
  pool: Pool;
  state: CountingPoolState;
} {
  const state: CountingPoolState = { inFlight: 0, peak: 0 };
  const pool = {
    on: () => pool,
    connect: async (): Promise<PoolClient> => {
      state.inFlight += 1;
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
    },
  };
  gateDbAcquisitions(pool as unknown as Pool);
  return { pool: pool as unknown as Pool, state };
}

/**
 * One relation-bearing read: the parent query plus one child per relation edge,
 * all started in the same tick — the shape Prisma 7 produces for a
 * non-transactional `findMany` with `include` (ISS-8431).
 */
export async function readWithRelations(
  pool: Pool,
  relationEdges: number
): Promise<void> {
  // Each child acquires, runs and releases on its own, which is what
  // `pool.query` does and therefore what every Prisma child query does. The
  // children never hold each other's connections — see the hold-and-wait test
  // in `packages/database` for why that distinction is load-bearing.
  await Promise.all(
    Array.from({ length: relationEdges + 1 }, async () => {
      const client = await pool.connect();
      await Promise.resolve();
      client.release();
    })
  );
}
