/**
 * ISS-8431: the acquisition budget bounds pooled connections, not ORM calls.
 *
 * These drive the real gate over a fake pool. The pool is faked because the
 * contract under test is "how many clients may be checked out at once from one
 * scope", which is independent of what the connections are used for — the
 * end-to-end measurement against Postgres and a real Prisma client is in the
 * ticket's probe, recorded in the PR.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDbAcquisitionBudget,
  gateDbAcquisitions,
  withDbAcquisitionBudget,
} from "../acquisition-budget";
import {
  DB_ACQUISITION_BUDGET_MAX,
  DB_POOL_ACQUIRE_TIMEOUT_MESSAGE,
  DB_POOL_ACQUIRE_TIMEOUT_MS,
  DB_POOL_MAX_DATABASE_URL_DEFAULT,
} from "../pool-config";
import {
  acquireAndReleaseViaDone,
  createCallbackCountingPool,
  createCountingPool,
  readWithRelations,
} from "./support/counting-pool";

afterEach(() => {
  vi.useRealTimers();
});

describe("gateDbAcquisitions", () => {
  it("does not bound acquisitions outside a budget scope", async () => {
    const { pool, state } = createCountingPool();

    await readWithRelations(pool, 10);

    // The pre-fix behavior, kept as the counterfactual: one ORM call, eleven
    // simultaneous connections. Scripts, seeds and migrations run here.
    expect(state.peak).toBe(11);
  });

  it("bounds one relation-bearing read to the budget however wide the include tree", async () => {
    const { pool, state } = createCountingPool();

    await withDbAcquisitionBudget(
      () => readWithRelations(pool, 10),
      createDbAcquisitionBudget()
    );

    expect(state.handedOut).toBe(11);
    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("bounds the whole scope, not each read, when reads run concurrently", async () => {
    const { pool, state } = createCountingPool();

    await withDbAcquisitionBudget(
      () =>
        Promise.all([
          readWithRelations(pool, 6),
          readWithRelations(pool, 6),
          readWithRelations(pool, 6),
        ]),
      createDbAcquisitionBudget()
    );

    expect(state.handedOut).toBe(21);
    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("is idempotent, so a re-gated pool cannot stack two budgets", async () => {
    const { pool, state } = createCountingPool();
    gateDbAcquisitions(pool);

    await withDbAcquisitionBudget(
      () => readWithRelations(pool, 10),
      createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("returns the permit when the underlying acquisition fails", async () => {
    const { pool, state, failNext } = createCountingPool();

    await withDbAcquisitionBudget(async () => {
      failNext(new Error("connection refused"));
      await expect(pool.connect()).rejects.toThrow("connection refused");
      // A leaked permit would leave the budget one short forever; a full-width
      // read afterwards proves it came back.
      await readWithRelations(pool, 10);
    }, createDbAcquisitionBudget());

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
    expect(state.handedOut).toBe(11);
  });

  it("returns the permit for a client the pool removes instead of releasing", async () => {
    const { pool, removeClient } = createCountingPool();
    const budget = createDbAcquisitionBudget(1);

    await withDbAcquisitionBudget(async () => {
      const client = await pool.connect();
      removeClient(client);
      // With the permit leaked this would hang until the acquire timeout.
      const next = await pool.connect();
      next.release();
    }, budget);

    expect(budget.inUse).toBe(0);
  });

  it("fails, rather than hangs, a caller that holds more connections than the budget", async () => {
    // The one shape that can deadlock a budget: acquire N > limit at once and
    // release none until all N arrive. No repo path does it — `pool.query`
    // releases per query and an interactive transaction takes exactly one
    // connection — but the permit timeout is what keeps a future one bounded,
    // so it is pinned here rather than left to be optimised away.
    vi.useFakeTimers();
    const { pool } = createCountingPool();

    const held = withDbAcquisitionBudget(
      () =>
        Promise.all(
          Array.from({ length: DB_ACQUISITION_BUDGET_MAX + 1 }, () =>
            pool.connect()
          )
        ),
      createDbAcquisitionBudget()
    );
    const settled = expect(held).rejects.toThrow(
      DB_POOL_ACQUIRE_TIMEOUT_MESSAGE
    );
    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS + 1);
    await settled;
  });

  it("fails a starved permit with the message pool telemetry classifies", async () => {
    vi.useFakeTimers();
    const { pool } = createCountingPool();
    const budget = createDbAcquisitionBudget(1);

    const held = await withDbAcquisitionBudget(() => pool.connect(), budget);
    const starved = withDbAcquisitionBudget(() => pool.connect(), budget);
    // Attached before the clock moves: an assertion added afterwards would see
    // the right rejection but leave it momentarily unhandled.
    const rejection = expect(starved).rejects.toThrow(
      DB_POOL_ACQUIRE_TIMEOUT_MESSAGE
    );
    await vi.advanceTimersByTimeAsync(DB_POOL_ACQUIRE_TIMEOUT_MS + 1);
    await rejection;

    // The starved waiter must also be off the queue, or releasing the permit
    // would hand it to a caller that has already given up.
    held.release();
    expect(budget.inUse).toBe(0);
    expect(budget.waiters).toHaveLength(0);
  });
});

describe("withDbAcquisitionBudget", () => {
  it("joins an ambient budget instead of opening a second one", async () => {
    const { pool, state } = createCountingPool();

    await withDbAcquisitionBudget(
      () =>
        withDbAcquisitionBudget(
          () => readWithRelations(pool, 10),
          createDbAcquisitionBudget()
        ),
      createDbAcquisitionBudget()
    );

    // Nesting must not grant a fresh ceiling on top of the caller's.
    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("gates work started by a lazy promise awaited inside the scope", async () => {
    const { pool, state } = createCountingPool();
    // A Prisma query is lazy: it starts no work until awaited. If the scope were
    // exited before the await, the gate would see no budget and silently do
    // nothing — the exact way this fix can be broken without any test failing.
    // A thenable IS the subject here: `PrismaPromise` is one, and only a
    // thenable defers its work to the moment of the await.
    const lazy = {
      // biome-ignore lint/suspicious/noThenProperty: modelling PrismaPromise
      then: (resolve: (value: unknown) => void) =>
        readWithRelations(pool, 10).then(resolve),
    };

    await withDbAcquisitionBudget(
      async () => await lazy,
      createDbAcquisitionBudget()
    );

    expect(state.peak).toBe(DB_ACQUISITION_BUDGET_MAX);
  });

  it("clamps a non-finite or sub-1 limit rather than admitting NaN", () => {
    expect(createDbAcquisitionBudget(Number.NaN).limit).toBe(
      DB_ACQUISITION_BUDGET_MAX
    );
    expect(createDbAcquisitionBudget(Number.POSITIVE_INFINITY).limit).toBe(
      DB_ACQUISITION_BUDGET_MAX
    );
    expect(createDbAcquisitionBudget(0).limit).toBe(1);
    expect(createDbAcquisitionBudget(-4).limit).toBe(1);
    expect(createDbAcquisitionBudget(3.7).limit).toBe(3);
  });
});

describe("DB_ACQUISITION_BUDGET_MAX", () => {
  it("spends at most half of the smallest pool", () => {
    expect(DB_ACQUISITION_BUDGET_MAX).toBeLessThanOrEqual(
      DB_POOL_MAX_DATABASE_URL_DEFAULT / 2
    );
  });

  it("stays above 1 so bounding does not serialize relation loading", () => {
    expect(DB_ACQUISITION_BUDGET_MAX).toBeGreaterThan(1);
  });
});

describe("gateDbAcquisitions callback API", () => {
  // pg passes the consumer the `released` function it captured BEFORE the gate
  // replaced `client.release`, so releasing through `done` — the documented
  // callback API — must still return the permit. Unwrapped it does not, and the
  // budget drains one permit per checkout with nothing ever giving them back.
  it("returns the permit when the caller releases through done", async () => {
    const { pool, state } = createCallbackCountingPool();
    const budget = createDbAcquisitionBudget(1);

    await withDbAcquisitionBudget(async () => {
      // More checkouts than the limit, each fully released before the next. A
      // leaked permit strands the second one until the acquire timeout.
      for (let i = 0; i < 3; i += 1) {
        await acquireAndReleaseViaDone(pool);
      }
    }, budget);

    expect(state.handedOut).toBe(3);
    expect(budget.inUse).toBe(0);
    expect(state.inFlight).toBe(0);
  });

  it("spends one permit when the caller releases through BOTH done and release", async () => {
    // The releaser is idempotent, so a belt-and-braces caller must not return a
    // permit it never took — that would let the budget drift ABOVE its ceiling.
    const { pool } = createCallbackCountingPool();
    const budget = createDbAcquisitionBudget(2);

    await withDbAcquisitionBudget(
      () =>
        new Promise<void>((resolve, reject) => {
          (
            pool.connect as unknown as (
              cb: (
                err: Error | undefined,
                client: { release: () => void } | undefined,
                done: () => void
              ) => void
            ) => void
          )((err, client, done) => {
            if (err || !client) {
              reject(err ?? new Error("no client"));
              return;
            }
            done();
            client.release();
            resolve();
          });
        }),
      budget
    );

    expect(budget.inUse).toBe(0);
    expect(budget.limit).toBe(2);
  });
});
