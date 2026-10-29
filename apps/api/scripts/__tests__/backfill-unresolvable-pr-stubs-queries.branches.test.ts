/**
 * ISS-11280 — branch-pinning coverage for
 * `backfill-unresolvable-pr-stubs-queries.ts` gaps: the revert statement's
 * "no row returned" fallback, and the private `limitSql` helper's two shapes
 * (a bound `LIMIT` vs `Prisma.empty`), asserted through the actual SQL
 * fragment `summarizeUnresolvableStubs` hands to `$queryRaw` — the only way
 * to observe `limitSql` from outside the module, since it is not exported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});

import {
  revertStampBackfill,
  summarizeUnresolvableStubs,
} from "../backfill-unresolvable-pr-stubs-queries";

type FakeSqlFragment = { sql: string; values: unknown[] };

function makeFakeDb(queryRawResult: unknown) {
  return { $queryRaw: vi.fn().mockResolvedValue(queryRawResult) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revertStampBackfill", () => {
  it("reports the closed and restored counts the revert statement returns", async () => {
    const db = makeFakeDb([{ closedCount: 3n, restoredCount: 2n }]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await revertStampBackfill("run-1");

    expect(result).toStrictEqual({ closedCount: 3, restoredCount: 2 });
    const query = db.$queryRaw.mock.calls[0][0] as FakeSqlFragment;
    expect(query.sql).toContain(
      "UPDATE pull_request_verification_stamp_backfill"
    );
    expect(query.sql).toContain("SET reverted_at = now()");
    expect(query.sql).toContain(
      "WHERE run_id = ?::uuid AND reverted_at IS NULL"
    );
    expect(query.values).toStrictEqual(["run-1"]);
  });

  it("reports zero for both counts when the revert statement returns no row", async () => {
    const db = makeFakeDb([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await revertStampBackfill("run-1");

    expect(result).toStrictEqual({ closedCount: 0, restoredCount: 0 });
  });
});

describe("summarizeUnresolvableStubs — the selected-window LIMIT", () => {
  it("omits the LIMIT clause from the selected CTE when no limit is passed", async () => {
    const db = makeFakeDb([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await summarizeUnresolvableStubs(
      new Date("2026-01-01T00:00:00.000Z"),
      null
    );

    const query = db.$queryRaw.mock.calls[0][0] as FakeSqlFragment;
    expect(query.sql).not.toContain("LIMIT");
    expect(result).toStrictEqual({
      groups: [],
      eligibleTotal: 0,
      selectedTotal: 0,
      truncated: false,
    });
  });

  it("binds the run's limit into the selected CTE's LIMIT clause", async () => {
    const db = makeFakeDb([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await summarizeUnresolvableStubs(
      new Date("2026-01-01T00:00:00.000Z"),
      25
    );

    const query = db.$queryRaw.mock.calls[0][0] as FakeSqlFragment;
    expect(query.sql).toContain("LIMIT ?");
    expect(query.values).toContain(25);
    expect(result).toStrictEqual({
      groups: [],
      eligibleTotal: 0,
      selectedTotal: 0,
      truncated: false,
    });
  });

  it("clamps a non-positive limit to 1", async () => {
    const db = makeFakeDb([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    await summarizeUnresolvableStubs(new Date("2026-01-01T00:00:00.000Z"), 0);

    const query = db.$queryRaw.mock.calls[0][0] as FakeSqlFragment;
    expect(query.values).toContain(1);
  });

  it("truncates a non-integer limit toward zero", async () => {
    const db = makeFakeDb([]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    await summarizeUnresolvableStubs(new Date("2026-01-01T00:00:00.000Z"), 2.7);

    const query = db.$queryRaw.mock.calls[0][0] as FakeSqlFragment;
    expect(query.values).toContain(2);
  });

  it("folds a non-empty group list into eligible/selected totals and flags truncation", async () => {
    const db = makeFakeDb([
      {
        organizationId: "org-1",
        repositoryFullName: "acme/widgets",
        eligibleCount: 5n,
        selectedCount: 2n,
        desktopStubBacklog: 5n,
      },
    ]);
    mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(db)
    );

    const result = await summarizeUnresolvableStubs(
      new Date("2026-01-01T00:00:00.000Z"),
      2
    );

    expect(result.eligibleTotal).toBe(5);
    expect(result.selectedTotal).toBe(2);
    expect(result.truncated).toBe(true);
  });
});
