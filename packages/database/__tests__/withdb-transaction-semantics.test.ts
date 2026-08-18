import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDb } from "../index";

/**
 * Transaction/AsyncLocalStorage semantics of `withDb` and `withDb.tx`.
 *
 * Uses the technique this package's AGENTS.md documents: inject a mock
 * PrismaClient into the `globalForPrisma` global cache so `getDatabase()`
 * returns it without building a pool. Real AsyncLocalStorage still runs, so the
 * ambient-transaction propagation being asserted here is the production
 * mechanism, not a stand-in for it.
 *
 * The case that matters most is the ISS-4669 fail-closed guard: requesting an
 * `isolationLevel` while an ambient transaction is already open must THROW.
 * Postgres fixes isolation at BEGIN, so a nested request can neither strengthen
 * the outer level nor prove it already matches — silently joining a
 * default-READ-COMMITTED outer transaction would hand back a weaker snapshot
 * than the caller asked for, which is exactly the relink undercount/double-count
 * that ticket closed.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: unknown;
  pool: unknown;
  signer: unknown;
};

const AMBIENT_ISOLATION_REFUSAL = /cannot honor isolationLevel/;
const REPEATABLE_READ = /RepeatableRead/;

type FakeTx = { id: string };

let previousPrisma: unknown;
let transactionCalls: unknown[];

beforeEach(() => {
  previousPrisma = globalForPrisma.prisma;
  transactionCalls = [];
  globalForPrisma.prisma = {
    $transaction: (fn: (tx: FakeTx) => Promise<unknown>, options?: unknown) => {
      transactionCalls.push(options);
      return fn({ id: "outer-tx" });
    },
  };
});

afterEach(() => {
  globalForPrisma.prisma = previousPrisma;
  vi.restoreAllMocks();
});

describe("withDb — outside a transaction", () => {
  it("hands the callback the pooled client", async () => {
    const seen = await withDb((db) => Promise.resolve(db));

    expect(seen).toBe(globalForPrisma.prisma);
  });

  it("returns the callback's value", async () => {
    expect(await withDb(() => Promise.resolve(42))).toBe(42);
  });

  it("supports a synchronous callback", async () => {
    // The signature allows `T | Promise<T>`; a sync callback must not be
    // treated as a thenable-less failure.
    expect(await withDb(() => "sync")).toBe("sync");
  });
});

describe("withDb.tx — opening a transaction", () => {
  it("opens one and runs the callback inside it", async () => {
    const seen = await withDb.tx((tx) => Promise.resolve(tx));

    expect(seen).toEqual({ id: "outer-tx" });
    expect(transactionCalls).toHaveLength(1);
  });

  it("forwards transaction options to Prisma", async () => {
    await withDb.tx(() => Promise.resolve(null), {
      maxWait: 111,
      timeout: 222,
    });

    expect(transactionCalls[0]).toMatchObject({ maxWait: 111, timeout: 222 });
  });

  it("forwards an isolationLevel when it IS the outermost transaction", async () => {
    await withDb.tx(() => Promise.resolve(null), {
      isolationLevel: "Serializable" as never,
    });

    expect(transactionCalls[0]).toMatchObject({
      isolationLevel: "Serializable",
    });
  });
});

describe("withDb / withDb.tx — joining an ambient transaction", () => {
  it("gives a nested withDb the AMBIENT tx, not a pooled client", async () => {
    const seen = await withDb.tx((outer) =>
      withDb((inner) => Promise.resolve({ outer, inner }))
    );

    expect(seen.inner).toBe(seen.outer);
    // One transaction total — the nested call joined rather than opening a
    // second one.
    expect(transactionCalls).toHaveLength(1);
  });

  it("gives a nested withDb.tx the same tx without opening another", async () => {
    const seen = await withDb.tx((outer) =>
      withDb.tx((inner) => Promise.resolve({ outer, inner }))
    );

    expect(seen.inner).toBe(seen.outer);
    expect(transactionCalls).toHaveLength(1);
  });

  it("ignores maxWait/timeout on the nested call", async () => {
    // Those options belong to whoever opened the transaction; the nested call
    // simply joins, and only ONE set of options ever reaches Prisma.
    await withDb.tx(() =>
      withDb.tx(() => Promise.resolve(null), { maxWait: 999, timeout: 999 })
    );

    expect(transactionCalls).toHaveLength(1);
    expect(transactionCalls[0]).toBeUndefined();
  });

  it("THROWS when an isolationLevel is requested inside an ambient transaction", async () => {
    // ISS-4669 fail-closed: the outer level is fixed at BEGIN and may be weaker
    // than requested, so returning a silently-wrong snapshot is not an option.
    await expect(
      withDb.tx(() =>
        withDb.tx(() => Promise.resolve(null), {
          isolationLevel: "Serializable" as never,
        })
      )
    ).rejects.toThrow(AMBIENT_ISOLATION_REFUSAL);
  });

  it("names the requested level in the refusal", async () => {
    // The caller needs to know WHICH guarantee could not be honored.
    await expect(
      withDb.tx(() =>
        withDb.tx(() => Promise.resolve(null), {
          isolationLevel: "RepeatableRead" as never,
        })
      )
    ).rejects.toThrow(REPEATABLE_READ);
  });

  it("does not run the nested callback when it refuses", async () => {
    const nested = vi.fn().mockResolvedValue(null);

    await withDb
      .tx(() => withDb.tx(nested, { isolationLevel: "Serializable" as never }))
      .catch(() => undefined);

    expect(nested).not.toHaveBeenCalled();
  });

  it("propagates the ambient tx through an intermediate await", async () => {
    // The store must survive a microtask boundary — this is the property that
    // makes service methods composable without threading a `tx` parameter.
    const seen = await withDb.tx(async (outer) => {
      await Promise.resolve();
      return withDb((inner) => Promise.resolve({ outer, inner }));
    });

    expect(seen.inner).toBe(seen.outer);
  });
});
