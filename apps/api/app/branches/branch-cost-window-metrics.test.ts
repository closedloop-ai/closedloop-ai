import { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDbPlain: vi.fn(),
  withDbTx: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: Object.assign(mocks.withDbPlain, { tx: mocks.withDbTx }),
  };
});

import { readCostMetricFacts } from "./branch-cost-window-metrics";

/**
 * ISS-12346 B4: the rollup freshness gate and the aggregation that trusts it
 * must observe one MVCC snapshot. A refresh pass committing between them can
 * purge a session's rollup rows after the gate passed, and the fold would then
 * publish an undercount as Complete.
 */

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ELIGIBLE = Prisma.sql`SELECT NULL::uuid AS id`;
const WINDOWS = [
  { key: "all", startAt: null, endAt: "2026-09-30T00:00:00.000Z" },
];

describe("readCostMetricFacts", () => {
  it("runs the gate and the aggregation in one RepeatableRead transaction", async () => {
    // One session, so the slice statement runs and the gate is consulted.
    mocks.queryRaw.mockImplementation((statement: Prisma.Sql) =>
      Promise.resolve(
        statement.strings.join("").includes("divisor_branches")
          ? [{ session_id: ORGANIZATION_ID, share: 1 }]
          : []
      )
    );
    mocks.withDbTx.mockImplementation(
      (run: (db: { $queryRaw: typeof mocks.queryRaw }) => unknown) =>
        run({ $queryRaw: mocks.queryRaw })
    );

    await readCostMetricFacts(ORGANIZATION_ID, [], ELIGIBLE, WINDOWS);

    expect(mocks.withDbPlain).not.toHaveBeenCalled();
    expect(mocks.withDbTx).toHaveBeenCalledOnce();
    expect(mocks.withDbTx.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      })
    );
    // The shares read, the gate's state read, and the slice statement that
    // trusts it: all three on that one client.
    expect(mocks.queryRaw.mock.calls.length).toBe(3);
  });
});
