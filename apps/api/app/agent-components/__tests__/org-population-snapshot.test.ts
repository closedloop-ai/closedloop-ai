/**
 * ISS-4669: `buildOrgComponentPopulation` reads FK-linked usage
 * (`loadUsageGroupsForInventory`) and orphan (null-FK) usage
 * (`loadOrphanUsageRows`) inside ONE `RepeatableRead` interactive transaction so
 * both observe the SAME committed MVCC snapshot.
 *
 * Run as two separate pooled reads (the prior shape), an `agentComponentId`
 * relink committing BETWEEN them mis-counts:
 *   - null→id: the row is absent from the FK snapshot AND excluded from the
 *     orphan snapshot → dropped from BOTH lanes → the component undercounts.
 *   - id→null: the row is seen by the FK read AND the orphan read → its
 *     invocations + errors double-count (the per-session Set only dedups the
 *     session COUNT, not the summed invocation/error totals).
 *
 * These tests pin two guarantees that make the race impossible:
 *   1. Both usage reads execute against the SAME transaction client — the one
 *      `withDb.tx` yields — never the pooled `withDb` connection.
 *   2. The transaction is opened at `RepeatableRead` isolation.
 * Plus a reconciliation fixture (an orphan row + an FK-linked row for the same
 * identity) whose folded totals are internally consistent: no drop, no
 * double-count.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const REPEATABLE_READ = "RepeatableRead";
// Matches `USAGE_SNAPSHOT_TX_TIMEOUT_MS` in `../org-population` — the generous
// ceiling that keeps the snapshot transaction from regressing a large (but
// row-capped) org into Prisma's 5s default interactive-transaction timeout.
const EXPECTED_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  // Mirror of the real `@repo/database` export the population reads under test
  // reference for the interactive-transaction isolation level.
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn().mockResolvedValue([]) },
}));

import { buildOrgComponentPopulation } from "../org-population";
import {
  buildPopulationDb,
  makeInventoryRow,
  makeOrphanUsage,
  makeRollup,
  ORG_A,
  type PopulationFixtures,
  TARGET_1,
} from "./org-population-fixtures";
import { orphanGroupByCalls } from "./usage-lane-doubles";

/**
 * Wire the pooled `withDb` and the transactional `withDb.tx` to DISTINCT fake
 * clients so a read that ran on the wrong one is observable. Both clients are
 * built from the same fixtures, but only the read that actually ran on the tx
 * client leaves a call on IT. Returns the two clients + the isolation options
 * captured from the `withDb.tx` call so the tests can assert the snapshot
 * guarantees directly.
 */
function installSnapshotDb(fixtures: PopulationFixtures) {
  const pooled = buildPopulationDb(fixtures);
  const tx = buildPopulationDb(fixtures);
  const capturedTxOptions: { isolationLevel?: string; timeout?: number }[] = [];

  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(pooled.db)
  );
  mocks.withDb.tx.mockImplementation(
    (
      callback: (client: unknown) => unknown,
      options?: { isolationLevel?: string; timeout?: number }
    ) => {
      capturedTxOptions.push(options ?? {});
      return callback(tx.db);
    }
  );

  return { pooled, tx, capturedTxOptions };
}

/**
 * A component whose usage arrives on BOTH lanes: two FK-linked invocations and,
 * for the SAME `(kind, key)` identity, one orphan (null-FK) invocation that the
 * component-sync lane never linked. The reconciled total must be their sum with
 * no lane dropped and no session double-counted.
 */
function splitLaneFixtures(): PopulationFixtures {
  return {
    inventory: [
      makeInventoryRow({
        id: "c-review",
        componentKind: "command",
        componentKey: "code-review",
        name: "Code Review",
        computeTargetId: TARGET_1,
      }),
    ],
    rollups: [
      makeRollup({
        agentComponentId: "c-review",
        sessionId: "s-fk-1",
        invocationCount: 5,
        errorCount: 2,
      }),
      makeRollup({
        agentComponentId: "c-review",
        sessionId: "s-fk-2",
        invocationCount: 3,
        errorCount: 0,
      }),
    ],
    orphanUsage: [
      makeOrphanUsage({
        agentSessionId: "s-orphan-1",
        componentKind: "command",
        componentKey: "code-review",
        invocationCount: 4,
        errorCount: 1,
      }),
    ],
  };
}

describe("buildOrgComponentPopulation — consistent usage snapshot (ISS-4669)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads FK-linked and orphan usage on the SAME transaction client, not the pooled connection", async () => {
    const { pooled, tx } = installSnapshotDb(splitLaneFixtures());

    await buildOrgComponentPopulation(pooled.db as never, {
      organizationId: ORG_A,
    });

    // Both usage lanes landed on the transactional client's delegates. ISS-4799
    // moved the orphan lane off `findMany` onto an identity-capped `groupBy`
    // pair (spine + aggregate), so all three usage reads — the FK rollup plus
    // the orphan spine and aggregate — arrive on the SAME `groupBy` delegate.
    expect(tx.groupBy).toHaveBeenCalledTimes(3);
    expect(orphanGroupByCalls({ groupBy: tx.groupBy })).toHaveLength(2);
    // …and NEITHER lane ran on the pooled connection, so they cannot straddle
    // two snapshots the way the pre-fix two-pooled-reads shape did.
    expect(pooled.groupBy).not.toHaveBeenCalled();
    expect(pooled.usageFindMany).not.toHaveBeenCalled();
  });

  it("reads the org INVENTORY bound on that same transaction client (ISS-6180, shafty023)", async () => {
    // The inventory read supplies the FK lane's `in` bound, and the usage-only
    // lane now partitions on `agentComponent.uninstalledAt` — the same fact. Left
    // on the pool it is a SECOND snapshot, so a tombstone committing in between
    // leaves the id in the FK bound while the transaction also admits the row to
    // the usage-only lane (double-count), and a restore drops it from both
    // (undercount). This fixture seeds no plugin, so the child-usage rollup
    // short-circuits and cannot account for a stray pooled inventory read.
    const { pooled, tx } = installSnapshotDb(splitLaneFixtures());

    await buildOrgComponentPopulation(pooled.db as never, {
      organizationId: ORG_A,
    });

    expect(tx.inventoryGroupBy).toHaveBeenCalled();
    expect(tx.findMany).toHaveBeenCalled();
    expect(pooled.inventoryGroupBy).not.toHaveBeenCalled();
    expect(pooled.findMany).not.toHaveBeenCalled();
  });

  it("opens the usage-read transaction at RepeatableRead isolation with a raised timeout", async () => {
    const { pooled, capturedTxOptions } = installSnapshotDb(
      splitLaneFixtures()
    );

    await buildOrgComponentPopulation(pooled.db as never, {
      organizationId: ORG_A,
    });

    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(capturedTxOptions).toHaveLength(1);
    expect(capturedTxOptions[0]?.isolationLevel).toBe(REPEATABLE_READ);
    // The raised timeout keeps the snapshot tx from regressing a large org into
    // Prisma's 5s default, so it must actually reach `withDb.tx`.
    expect(capturedTxOptions[0]?.timeout).toBe(EXPECTED_SNAPSHOT_TX_TIMEOUT_MS);
    // Guard the literal against a silent drift from the real Prisma enum member.
    expect(REPEATABLE_READ).toBe(
      mocks.Prisma.TransactionIsolationLevel.RepeatableRead
    );
  });

  it("reconciles FK-linked + orphan usage for one identity: no lane dropped, no double-count", async () => {
    const { pooled } = installSnapshotDb(splitLaneFixtures());

    const merged = await buildOrgComponentPopulation(pooled.db as never, {
      organizationId: ORG_A,
    });

    const review = [...merged.values()].find((m) => m.key === "code-review");
    expect(review).toBeDefined();
    // FK invocations (5 + 3) + orphan invocations (4) = 12 — both lanes folded,
    // neither dropped.
    expect(review?.totalInvocations).toBe(12);
    // FK errors (2 + 0) + orphan errors (1) = 3.
    expect(review?.totalErrors).toBe(3);
    // Three DISTINCT sessions across the two lanes; the orphan session is not the
    // same as either FK session, so the count is 3 — not double-counted.
    expect(review?.sessionIds.size).toBe(3);
  });
});
