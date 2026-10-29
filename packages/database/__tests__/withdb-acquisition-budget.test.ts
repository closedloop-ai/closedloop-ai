import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDb } from "../index";
import { DB_ACQUISITION_BUDGET_MAX } from "../pool-config";
import { createCountingPool, readWithRelations } from "./support/counting-pool";

/**
 * ISS-8431: `withDb` and `withDb.tx` must open an acquisition budget.
 *
 * The budget machinery has its own unit tests; what this file pins is the
 * WIRING. Without it every test there still passes while production reads run
 * unbounded, because nothing else asserts that the production entry point
 * enters a scope at all.
 *
 * Uses the technique this package's AGENTS.md documents: inject a mock
 * PrismaClient into the `globalForPrisma` global cache so `getDatabase()`
 * returns it without building a pool. Real AsyncLocalStorage still runs, so the
 * scope being asserted is the production mechanism.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: unknown;
  pool: unknown;
  signer: unknown;
};

type FakeTx = { id: string };

let previousPrisma: unknown;

beforeEach(() => {
  previousPrisma = globalForPrisma.prisma;
  globalForPrisma.prisma = {
    $transaction: (fn: (tx: FakeTx) => Promise<unknown>) =>
      fn({ id: "outer-tx" }),
  };
});

afterEach(() => {
  globalForPrisma.prisma = previousPrisma;
});

describe("withDb acquisition budget wiring", () => {
  const WIDE_INCLUDE_EDGES = 10;

  it("bounds a relation-bearing read run inside withDb", async () => {
    const { pool, state } = createCountingPool();

    await withDb(() => readWithRelations(pool, WIDE_INCLUDE_EDGES));

    expect(state.handedOut).toBe(WIDE_INCLUDE_EDGES + 1);
    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("bounds a relation-bearing read run inside withDb.tx", async () => {
    const { pool, state } = createCountingPool();

    await withDb.tx(() => readWithRelations(pool, WIDE_INCLUDE_EDGES));

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("has a nested withDb join the outer budget rather than open a second", async () => {
    const { pool, state } = createCountingPool();

    await withDb(() =>
      Promise.all([
        withDb(() => readWithRelations(pool, 6)),
        withDb(() => readWithRelations(pool, 6)),
        withDb(() => readWithRelations(pool, 6)),
      ])
    );

    expect(state.handedOut).toBe(21);
    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("keeps the budget in scope for a synchronous callback's returned promise", async () => {
    // `withDb` accepts `T | Promise<T>`, and the common call shape returns a
    // lazy Prisma promise rather than awaiting it. If the scope closed before
    // that promise started, the gate would silently see no budget.
    const { pool, state } = createCountingPool();

    await withDb(() => readWithRelations(pool, WIDE_INCLUDE_EDGES));

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });
});
