/**
 * TS-U.1 & TS-U.2: Unit tests for seed helpers.
 *
 * Covers:
 *  TS-U.1  deterministicUuid — stable for same input, different for different input
 *  TS-U.2  upsertRow — calls the upsert function, increments counts correctly
 *          createUpsertCounts — returns empty accumulator
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSeedBatchTransactionRunner,
  createUpsertCounts,
  deterministicUuid,
  forEachSeedBatch,
  upsertRow,
} from "../../helpers";
import {
  resolveSeedRunPlan,
  SeedProfileName,
  SeedTransactionMode,
} from "../../profiles";

/** UUID v5 format pattern: 8-4-4-4-12 with version nibble = 5 */
const UUID_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// TS-U.1: deterministicUuid
describe("deterministicUuid (TS-U.1)", () => {
  it("returns the same UUID for the same key", () => {
    const a = deterministicUuid("my-key");
    const b = deterministicUuid("my-key");
    expect(a).toBe(b);
  });

  it("returns a different UUID for a different key", () => {
    const a = deterministicUuid("key-one");
    const b = deterministicUuid("key-two");
    expect(a).not.toBe(b);
  });

  it("returns a string in UUID 8-4-4-4-12 format", () => {
    const uuid = deterministicUuid("format-check");
    expect(uuid).toMatch(UUID_V5_PATTERN);
  });

  it("is stable across different call sites (idempotent)", () => {
    const key = "seed:project:org-123:platform";
    const results = Array.from({ length: 5 }, () => deterministicUuid(key));
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it("produces different UUIDs for keys that differ only by prefix", () => {
    const a = deterministicUuid("team:org1:default");
    const b = deterministicUuid("project:org1:default");
    expect(a).not.toBe(b);
  });
});

// TS-U.2: upsertRow + createUpsertCounts
describe("upsertRow (TS-U.2)", () => {
  it("calls the upsert function and returns its result", async () => {
    const counts = createUpsertCounts();
    const mockResult = { id: "abc-123", name: "Test" };
    const upsertFn = vi.fn().mockResolvedValue(mockResult);

    const result = await upsertRow({
      model: "Project",
      id: "abc-123",
      upsert: upsertFn,
      counts,
    });

    expect(upsertFn).toHaveBeenCalledOnce();
    expect(result).toEqual(mockResult);
  });

  it("increments upserted count on each call", async () => {
    const counts = createUpsertCounts();

    await upsertRow({
      model: "Team",
      id: "new-id",
      upsert: vi.fn().mockResolvedValue({ id: "new-id" }),
      counts,
    });

    expect(counts.Team).toEqual({ upserted: 1 });
  });

  it("accumulates upserted count across multiple calls to the same model", async () => {
    const counts = createUpsertCounts();

    await upsertRow({
      model: "Artifact",
      id: "id-1",
      upsert: vi.fn().mockResolvedValue({ id: "id-1" }),
      counts,
    });
    await upsertRow({
      model: "Artifact",
      id: "id-2",
      upsert: vi.fn().mockResolvedValue({ id: "id-2" }),
      counts,
    });
    await upsertRow({
      model: "Artifact",
      id: "id-3",
      upsert: vi.fn().mockResolvedValue({ id: "id-3" }),
      counts,
    });

    expect(counts.Artifact).toEqual({ upserted: 3 });
  });

  it("increments upserted count when called without exists callback", async () => {
    const counts = createUpsertCounts();

    await upsertRow({
      model: "SlugCounter",
      id: "slug-id",
      upsert: vi.fn().mockResolvedValue({ id: "slug-id" }),
      counts,
    });

    expect(counts.SlugCounter).toEqual({ upserted: 1 });
  });

  it("accumulates independent counts per model", async () => {
    const counts = createUpsertCounts();

    await upsertRow({
      model: "Team",
      id: "t1",
      upsert: vi.fn().mockResolvedValue({ id: "t1" }),
      counts,
    });
    await upsertRow({
      model: "Project",
      id: "p1",
      upsert: vi.fn().mockResolvedValue({ id: "p1" }),
      counts,
    });

    expect(counts.Team).toEqual({ upserted: 1 });
    expect(counts.Project).toEqual({ upserted: 1 });
  });
});

describe("createUpsertCounts", () => {
  it("returns an empty object", () => {
    const counts = createUpsertCounts();
    expect(Object.keys(counts)).toHaveLength(0);
  });
});

describe("forEachSeedBatch", () => {
  it("processes every item in bounded chunks", async () => {
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    const indexes: number[] = [];

    await forEachSeedBatch({
      items,
      batchSize: 2,
      label: "test rows",
      run: (item, index) => {
        seen.push(item);
        indexes.push(index);
        return Promise.resolve();
      },
    });

    expect(seen).toEqual(items);
    expect(indexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("runs each batch inside its own transaction when a batch runner is provided", async () => {
    const items = [1, 2, 3, 4, 5];
    const batches: number[][] = [];
    const runBatch = vi.fn(async (run) => {
      batches.push([]);
      await run({ marker: `tx-${runBatch.mock.calls.length}` } as never);
    });

    await forEachSeedBatch({
      items,
      batchSize: 2,
      label: "test rows",
      runBatch,
      run: (item, _index, batchClient) => {
        expect(batchClient).toBeDefined();
        const batch = batches.at(-1);
        if (batch) {
          batch.push(item);
          return Promise.resolve();
        }
        batches.push([item]);
        return Promise.resolve();
      },
    });

    expect(runBatch).toHaveBeenCalledTimes(3);
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("createSeedBatchTransactionRunner", () => {
  it("wraps batched profile chunks in bounded Prisma transactions", async () => {
    const plan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    const txClient = { marker: "tx" };
    const prisma = {
      $transaction: vi.fn(async (run) => run(txClient)),
    };

    const runBatch = createSeedBatchTransactionRunner(
      prisma as never,
      plan.transaction
    );

    await expect(
      runBatch?.((client) => {
        expect(client).toBe(txClient);
        return Promise.resolve();
      })
    ).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: plan.transaction.timeoutMs,
      maxWait: plan.transaction.maxWaitMs,
    });
  });

  it("does not create a batch transaction runner for single-transaction mode", () => {
    const plan = resolveSeedRunPlan({ profile: SeedProfileName.Local });
    expect(plan.transaction.mode).toBe(SeedTransactionMode.SingleTransaction);
    expect(
      createSeedBatchTransactionRunner(
        { $transaction: vi.fn() } as never,
        plan.transaction
      )
    ).toBeUndefined();
  });
});
