/**
 * ISS-8431 / ISS-6942: the acquisition budget survives bundling.
 *
 * Turbopack emits `@repo/database` into several chunk groups for `apps/api` —
 * measured in built output, see `cross-bundle-registration.test.ts` — while
 * `globalForPrisma.pool` puts ONE pool object on `globalThis`. So the copy that
 * gates that shared pool and the copy whose `withDb` opens a scope need not be
 * the same module instance.
 *
 * With a module-local `AsyncLocalStorage` they are not compatible: the
 * registered `ACQUISITION_GATED` symbol makes the second copy skip installing
 * its gate, and the installed gate then reads a storage nobody writes to. Every
 * acquisition on those routes passes through unbounded, silently — it fails
 * OPEN, which is why it needs its own assertion rather than being implied by
 * the in-module cases.
 *
 * A second module registry reproduces the split here, the same technique the
 * ISS-6942 sibling suite uses. Each case asserts the OBSERVABLE consequence —
 * the peak number of clients checked out at once — not that the source mentions
 * `globalThis`.
 */
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDbAcquisitionBudget,
  gateDbAcquisitions,
  withDbAcquisitionBudget,
} from "../acquisition-budget";
import { DB_ACQUISITION_BUDGET_MAX } from "../pool-config";

type BudgetModule = typeof import("../acquisition-budget");

/** The slot key the production module registers its storage under. */
const BUDGET_STORAGE_KEY = Symbol.for(
  "closedloop.database.acquisitionBudgetStorage"
);

const RELATION_EDGES = DB_ACQUISITION_BUDGET_MAX * 2;

afterEach(() => {
  vi.resetModules();
});

/**
 * A pool double that reports the peak number of clients checked out at once.
 *
 * Built here rather than imported from `support/counting-pool` because that
 * helper gates the pool with the FIRST module copy on purpose; these cases need
 * to choose which copy does the gating.
 */
function createUngatedCountingPool() {
  const state = { inFlight: 0, peak: 0 };
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
  return { pool: pool as unknown as Pool, state };
}

async function readWithRelations(pool: Pool, relationEdges: number) {
  await Promise.all(
    Array.from({ length: relationEdges + 1 }, async () => {
      const client = await pool.connect();
      await Promise.resolve();
      client.release();
    })
  );
}

/** A second instance of the module, as a second chunk group would hold. */
async function loadSecondModuleCopy(): Promise<BudgetModule> {
  vi.resetModules();
  return await import("../acquisition-budget");
}

describe("acquisition budget across bundler-emitted module copies", () => {
  it("bounds a scope opened by a second copy against a pool gated by the first", async () => {
    const { pool, state } = createUngatedCountingPool();

    // Copy A gates the shared pool and stamps the registered symbol on it.
    gateDbAcquisitions(pool);

    const copyB = await loadSecondModuleCopy();

    // Copy B's `gateDbAcquisitions` finds the symbol and installs nothing, so
    // the only gate on this pool is copy A's — reading copy A's storage.
    copyB.gateDbAcquisitions(pool);

    await copyB.withDbAcquisitionBudget(
      () => readWithRelations(pool, RELATION_EDGES),
      copyB.createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("bounds a scope opened by the first copy against a pool gated by the second", async () => {
    // The mirror image, so the fix cannot pass by happening to prefer whichever
    // copy loaded first.
    const { pool, state } = createUngatedCountingPool();

    const copyB = await loadSecondModuleCopy();
    copyB.gateDbAcquisitions(pool);

    await withDbAcquisitionBudget(
      () => readWithRelations(pool, RELATION_EDGES),
      createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("registers the storage in a process-wide slot both copies read", async () => {
    // The mechanism behind the two cases above, asserted directly: a second
    // copy must not create a storage of its own.
    const holder = globalThis as typeof globalThis & Record<symbol, unknown>;
    const registered = holder[BUDGET_STORAGE_KEY];

    expect(typeof registered).toBe("function");

    const copyB = await loadSecondModuleCopy();
    const { pool, state } = createUngatedCountingPool();
    copyB.gateDbAcquisitions(pool);

    expect(holder[BUDGET_STORAGE_KEY]).toBe(registered);

    // And the shared instance is the one actually in force, not just present.
    await withDbAcquisitionBudget(
      () => readWithRelations(pool, RELATION_EDGES),
      createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("still passes acquisitions through when no copy has an open scope", async () => {
    // The no-op path must survive the change: scripts, seeds and migrations run
    // outside any budget and keep the pool's own semantics.
    const { pool, state } = createUngatedCountingPool();
    const copyB = await loadSecondModuleCopy();
    copyB.gateDbAcquisitions(pool);

    await readWithRelations(pool, RELATION_EDGES);

    expect(state.peak).toBe(RELATION_EDGES + 1);
  });
});
