/**
 * Unit tests for withDb.tx() AsyncLocalStorage propagation behavior.
 *
 * These tests use the REAL AsyncLocalStorage from node:async_hooks (no mock).
 * Only the PrismaClient/getDatabase layer is mocked via globalForPrisma injection.
 *
 * Strategy: inject a mock PrismaClient into globalForPrisma.prisma so that
 * getDatabase() returns our mock without needing a real DB connection.
 */

import type { PrismaClient } from "@repo/database";
import { withDb, withImplicitTransaction } from "@repo/database";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Build a mock transaction client — a plain object that satisfies the
// TransactionClient interface for test purposes.
const mockTxClient: unknown = { _isMockTxClient: true };

// Build a mock PrismaClient where $transaction invokes the callback with
// mockTxClient and propagates exceptions correctly.
const mockPrisma = {
  $transaction: vi
    .fn()
    .mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockTxClient)
    ),
} as unknown as PrismaClient;

// ---------------------------------------------------------------------------
// Inject / clear mock Prisma client via globalForPrisma
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Inject mock Prisma client so getDatabase() returns it immediately.
  (globalThis as unknown as { prisma: unknown }).prisma = mockPrisma;
  // Reset call count between tests.
  vi.mocked(mockPrisma.$transaction as Mock).mockClear();
});

afterEach(() => {
  // Clear to null (not undefined) to match `PrismaClient | null` type.
  (globalThis as unknown as { prisma: PrismaClient | null }).prisma = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withDb AsyncLocalStorage propagation", () => {
  it("(a) nested withDb() inside withDb.tx() receives the transaction client", async () => {
    let capturedDb: unknown = null;

    await withDb.tx(async () => {
      // Inner withDb() — should see the ALS-stored tx, not a fresh DB client.
      capturedDb = await withDb((db) => Promise.resolve(db));
    });

    expect(capturedDb).toBe(mockTxClient);
  });

  it("(b) nested withDb.tx() reuses the parent transaction — $transaction called exactly once", async () => {
    let innerTxClient: unknown = null;

    await withDb.tx(async () => {
      // Nested withDb.tx() must reuse the ALS-stored tx and NOT start a new $transaction.
      innerTxClient = await withDb.tx((tx) => Promise.resolve(tx));
    });

    // $transaction should have been invoked only once (the outer call).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(innerTxClient).toBe(mockTxClient);
  });

  it("(c) top-level withDb() outside a transaction gets the regular database client", async () => {
    let capturedDb: unknown = null;

    // No withDb.tx() wrapper — ALS store is empty.
    capturedDb = await withDb((db) => Promise.resolve(db));

    // Should be the mock PrismaClient itself (returned by getDatabase()), not the tx client.
    expect(capturedDb).toBe(mockPrisma);
  });

  it("(d) withDb.tx() nested inside another withDb.tx() reuses the parent transaction", async () => {
    let outerTx: unknown = null;
    let innerTx: unknown = null;

    await withDb.tx(async (tx) => {
      outerTx = tx;
      await withDb.tx((innerTxArg) => {
        innerTx = innerTxArg;
        return Promise.resolve(undefined);
      });
    });

    // Both outer and inner should see the same transaction client.
    expect(outerTx).toBe(mockTxClient);
    expect(innerTx).toBe(mockTxClient);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("(e) error propagation: nested withDb.tx() that throws causes outer Promise to reject with the same error", async () => {
    const testError = new Error("test-transaction-error");

    await expect(
      withDb.tx(async () => {
        await withDb.tx(() => {
          throw testError;
        });
      })
    ).rejects.toThrow("test-transaction-error");
  });

  it("(f) withDb.tx() inside withImplicitTransaction() reuses the implicit transaction", async () => {
    let capturedTx: unknown = null;

    await withImplicitTransaction(async () => {
      // withImplicitTransaction sets up ALS with its own tx client.
      // withDb.tx() should reuse it rather than opening a new $transaction.
      capturedTx = await withDb.tx((tx) => Promise.resolve(tx));
    });

    // $transaction called once (by withImplicitTransaction), not a second time.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(capturedTx).toBe(mockTxClient);
  });

  it("(g) plain withDb() called two async levels deep within a withDb.tx() chain receives the transaction client", async () => {
    let deepCapturedDb: unknown = null;

    async function levelTwo() {
      deepCapturedDb = await withDb((db) => Promise.resolve(db));
    }

    async function levelOne() {
      await levelTwo();
    }

    await withDb.tx(async () => {
      await levelOne();
    });

    // Even two async levels deep, ALS propagates the tx context.
    expect(deepCapturedDb).toBe(mockTxClient);
  });
});
