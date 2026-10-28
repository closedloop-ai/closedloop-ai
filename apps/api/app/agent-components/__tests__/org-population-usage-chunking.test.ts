/**
 * ISS-5516: the FK usage rollup's `agentComponentId: { in: … }` id chunking.
 *
 * Removing the org population reads' raw-row ceiling (it truncated AFTER the
 * facet predicate, which is what made one component report four different
 * totals) left the inventory id list genuinely unbounded — and that ceiling was
 * derived from {@link POSTGRES_MAX_BIND_PARAMETERS} precisely BECAUSE these ids
 * are bound one parameter each. Postgres refuses a statement past that limit
 * outright, so chunking is what stands between the correctness fix and a 500 on
 * exactly the large orgs it targets.
 *
 * That makes `runUsageGroupByChunked` load-bearing, and the ceiling removal is
 * only safe if it actually partitions the id set. The sibling
 * `loc-per-dollar-chunking` suite pins the same contract for
 * `SESSION_LOC_ID_CHUNK_SIZE`; this is its counterpart for the usage lane.
 *
 * The failure this exists to catch is silent: a chunk loop that drops its last
 * partial chunk, double-counts a boundary id, or fans out inside the population
 * snapshot's interactive transaction produces a plausible number, not an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: vi.fn().mockResolvedValue([]) },
}));

import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { loadUsageGroupsForInventory } from "../org-population";
import { INVENTORY_USAGE_ID_CHUNK_SIZE } from "../usage-bind-budget";

const ORG = "org-usage-chunking";

describe("loadUsageGroupsForInventory id chunking (ISS-5516)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Every other assertion here is expressed RELATIVE to the chunk size, so they
  // would all stay green if it were raised past the wire-protocol ceiling — the
  // exact defect this suite exists to prevent. This is the one absolute pin.
  it("keeps the chunk size under the Postgres bind-parameter ceiling", () => {
    expect(INVENTORY_USAGE_ID_CHUNK_SIZE).toBeLessThan(
      POSTGRES_MAX_BIND_PARAMETERS
    );
  });

  it("issues no query for an empty id list", async () => {
    const { db, groupBy } = makeFakeDb();

    const result = await loadUsageGroupsForInventory(db, ORG, []);

    expect(result).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("issues exactly one statement for an id list within one chunk", async () => {
    // The regression that motivated the chunk SIZE: this lane runs inside a
    // fixed-timeout interactive transaction, so an org that worked before the
    // ceiling was removed must not start paying extra sequential round trips.
    const ids = idsOfLength(INVENTORY_USAGE_ID_CHUNK_SIZE);
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(db, ORG, ids);

    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it("keeps every IN predicate within the chunk size for an over-chunk id list", async () => {
    const ids = idsOfLength(INVENTORY_USAGE_ID_CHUNK_SIZE * 2 + 1);
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(db, ORG, ids);

    const args = groupByArgs(groupBy);
    expect(args).toHaveLength(3);
    for (const arg of args) {
      expect(arg.where.agentComponentId.in.length).toBeLessThanOrEqual(
        INVENTORY_USAGE_ID_CHUNK_SIZE
      );
      // Org scope rides on EVERY chunk, not just the first — a chunk that lost
      // it would read another org's usage into this org's totals.
      expect(arg.where.session.artifact.organizationId).toBe(ORG);
    }
  });

  it("partitions the id set — nothing skipped, nothing queried twice", async () => {
    const ids = idsOfLength(INVENTORY_USAGE_ID_CHUNK_SIZE * 2 + 1);
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(db, ORG, ids);

    const queried = groupByArgs(groupBy).flatMap(
      (arg) => arg.where.agentComponentId.in
    );
    // A dropped tail chunk understates every component it covered, and a
    // duplicated boundary id double-counts one — both produce a plausible wrong
    // total rather than an error, which is why this is pinned by set identity
    // and not just by length.
    expect(queried).toHaveLength(ids.length);
    expect(new Set(queried)).toEqual(new Set(ids));
  });

  it("concatenates every chunk's groups into the returned rollup", async () => {
    const ids = idsOfLength(INVENTORY_USAGE_ID_CHUNK_SIZE * 2 + 1);
    const { db } = makeFakeDb();

    const result = await loadUsageGroupsForInventory(db, ORG, ids);

    // One group per id, so a truncated concatenation is visible as a short
    // result. `agentComponentId` is in the groupBy key, so a given group belongs
    // to exactly one chunk and no re-aggregation is owed.
    expect(result).toHaveLength(ids.length);
    expect(new Set(result.map((row) => row.agentComponentId))).toEqual(
      new Set(ids)
    );
  });

  it("stays bind-safe and complete for an id set far past the bind ceiling", async () => {
    const ids = idsOfLength(POSTGRES_MAX_BIND_PARAMETERS * 3);
    const { db, groupBy, peakConcurrent } = makeFakeDb();

    const result = await loadUsageGroupsForInventory(db, ORG, ids);

    const args = groupByArgs(groupBy);
    const widest = Math.max(
      ...args.map((arg) => arg.where.agentComponentId.in.length)
    );
    expect(widest).toBeLessThan(POSTGRES_MAX_BIND_PARAMETERS);
    expect(result).toHaveLength(ids.length);
    // The other half of the trade: the chunk count is unbounded, so the loop
    // must stay SEQUENTIAL. A fan-out would demand one pooled connection per
    // chunk while this read already runs inside the population snapshot's
    // interactive transaction.
    expect(peakConcurrent()).toBe(1);
  });

  it("propagates a rejecting chunk instead of returning partial usage", async () => {
    const ids = idsOfLength(INVENTORY_USAGE_ID_CHUNK_SIZE * 2);
    const { db } = makeFakeDb({ rejectOnCall: 2 });

    // NOT fail-open, unlike the LOC/$ enrichment that shares this shape: these
    // groups ARE the org's usage totals, so swallowing a failed chunk would
    // silently understate every component it covered — a plausible wrong number,
    // which is the one outcome worse than an error.
    await expect(loadUsageGroupsForInventory(db, ORG, ids)).rejects.toThrow(
      CHUNK_FAILURE
    );
  });
});

const CHUNK_FAILURE = "chunk read failed";

/** `length` distinct inventory ids, in a stable order. */
function idsOfLength(length: number): string[] {
  return Array.from({ length }, (_unused, index) => `c${index}`);
}

/** The `groupBy` args recorded by the fake, one entry per issued statement. */
function groupByArgs(groupBy: ReturnType<typeof makeFakeDb>["groupBy"]) {
  return groupBy.mock.calls.map(
    ([args]) =>
      args as {
        where: {
          agentComponentId: { in: string[] };
          session: { artifact: { organizationId: string } };
        };
      }
  );
}

/**
 * A fake Prisma client whose `agentComponentSessionUsage.groupBy` returns one
 * group per requested id and records concurrency, so the suite can assert the
 * chunk loop is sequential rather than fanned out.
 *
 * `definitionVersion.findMany` resolves empty: every fixture group carries a null
 * `definitionVersionId`, so the hash resolution short-circuits and the assertions
 * stay about chunking rather than about version attribution.
 */
function makeFakeDb(options: { rejectOnCall?: number } = {}) {
  let inFlight = 0;
  let peak = 0;
  let callIndex = 0;
  const groupBy = vi.fn(
    (args: { where: { agentComponentId: { in: string[] } } }) => {
      callIndex += 1;
      if (options.rejectOnCall === callIndex) {
        return Promise.reject(new Error(CHUNK_FAILURE));
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const rows = args.where.agentComponentId.in.map((id) => ({
        agentComponentId: id,
        agentSessionId: `s-${id}`,
        gitBranch: "",
        harness: "claude",
        componentKind: "tool",
        componentKey: `key-${id}`,
        componentVersionHash: null,
        definitionVersionId: null,
        _sum: { invocationCount: 1, errorCount: 0 },
        _max: { lastInvokedAt: null },
      }));
      // Resolve on a later microtask so an accidental fan-out would overlap and
      // push `peak` above 1; a sequential loop keeps it at exactly 1.
      return Promise.resolve().then(() => {
        inFlight -= 1;
        return rows;
      });
    }
  );
  return {
    db: {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn().mockResolvedValue([]) },
    } as never,
    groupBy,
    peakConcurrent: () => peak,
  };
}
