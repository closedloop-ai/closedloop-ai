import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSqlFacets } from "@/app/agent-sessions/service/usage-sql-reader";

const queryRawTyped = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    Promise.resolve(fn({ $queryRawTyped: queryRawTyped })),
  sql: {
    sessionUsageTotals: (...args: unknown[]) => ({ stmt: "totals", args }),
    sessionCostSplit: (...args: unknown[]) => ({ stmt: "costSplit", args }),
    sessionFacetCounts: (...args: unknown[]) => ({ stmt: "facets", args }),
    sessionMergedPrLoc: (...args: unknown[]) => ({ stmt: "mergedPrLoc", args }),
    sessionLocCoverageCounts: (...args: unknown[]) => ({
      stmt: "locCoverage",
      args,
    }),
    sessionLastSyncTargets: (...args: unknown[]) => ({ stmt: "targets", args }),
  },
}));

const {
  EMPTY_USAGE_SQL_FACETS,
  readCostSplit,
  readFacetCounts,
  readLocCoverageCounts,
  readMergedPrLoc,
  readUsageTotals,
} = await import("@/app/agent-sessions/service/usage-sql-reader");

const WINDOW = {
  organizationId: "org-1",
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-02-01T00:00:00.000Z"),
};

/** Stands in for the runtime Decimal the statements return. */
const decimal = (text: string) => ({ toString: () => text });

beforeEach(() => {
  queryRawTyped.mockReset();
});

describe("readUsageTotals", () => {
  it("coerces bigint counts and Decimal sums into numbers", async () => {
    queryRawTyped.mockResolvedValue([
      {
        session_count: 64n,
        earliest_session_at: new Date("2026-01-02T10:00:00.000Z"),
        latest_session_at: new Date("2026-01-20T10:00:00.000Z"),
        input_tokens: decimal("1200"),
        output_tokens: decimal("340"),
        cache_read_tokens: decimal("0"),
        cache_write_tokens: decimal("7"),
        estimated_cost: decimal("12.345678"),
      },
    ]);
    const totals = await readUsageTotals(WINDOW, EMPTY_USAGE_SQL_FACETS);
    expect(totals.sessionCount).toBe(64);
    expect(totals.inputTokens).toBe(1200);
    expect(totals.estimatedCost).toBeCloseTo(12.345_678, 6);
    expect(totals.earliestSessionAt).toBe("2026-01-02T10:00:00.000Z");
  });

  it("reports an empty population as zeros and null timestamps", async () => {
    queryRawTyped.mockResolvedValue([
      {
        session_count: 0n,
        earliest_session_at: null,
        latest_session_at: null,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_tokens: null,
        estimated_cost: null,
      },
    ]);
    const totals = await readUsageTotals(WINDOW, EMPTY_USAGE_SQL_FACETS);
    // The nulls collapse because session_count already reports the emptiness —
    // see typed-sql-scalars. The timestamps keep theirs; the contract models it.
    expect(totals).toMatchObject({
      sessionCount: 0,
      inputTokens: 0,
      estimatedCost: 0,
      earliestSessionAt: null,
      latestSessionAt: null,
    });
  });

  it("survives a statement returning no row at all", async () => {
    queryRawTyped.mockResolvedValue([]);
    await expect(
      readUsageTotals(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toMatchObject({ sessionCount: 0, estimatedCost: 0 });
  });
});

describe("readCostSplit", () => {
  it("keeps a ledger nothing classified into as null, not 0", async () => {
    queryRawTyped.mockResolvedValue([
      {
        subscription_cost: null,
        metered_cost: decimal("4.5"),
        unclassified_cost: decimal("0"),
      },
    ]);
    const split = await readCostSplit(WINDOW, EMPTY_USAGE_SQL_FACETS);
    // An empty ledger and a ledger that totalled zero are different facts, and
    // the LOC/$ divisor is chosen from these.
    expect(split.subscriptionCost).toBeNull();
    expect(split.meteredCost).toBe(4.5);
    expect(split.unclassifiedCost).toBe(0);
  });

  it("forwards the shared subscription vocabulary and resolves its OWN metered one", async () => {
    queryRawTyped.mockResolvedValue([
      { subscription_cost: null, metered_cost: null, unclassified_cost: null },
    ]);
    // ISS-10753: `subscriptionBillingModes` is now the CALLER's responsibility
    // (the composer's `toFacets` resolves it once, shared with the
    // known/unknown-cost predicate) — this reader only forwards it. Passed
    // pre-sorted here, matching what the composer actually produces.
    await readCostSplit(WINDOW, {
      ...EMPTY_USAGE_SQL_FACETS,
      subscriptionBillingModes: ["max", "pro"],
    });
    const [statement] = queryRawTyped.mock.calls[0] as [{ args: unknown[] }];
    // $22 is INSIDE the shared prefix and $26 comes AFTER it — the prefix ran to
    // $24 once ISS-10332's priority arms joined it, and to $25 once ISS-12251's
    // creator scope did. A statement-specific
    // parameter is appended rather than interleaved precisely so the prefix is
    // identical on every statement and one builder can serve them all;
    // interleaving would make this the one tuple the caller has to special-case.
    const subscription = statement.args[21] as string[];
    const metered = statement.args[25] as string[];
    expect(subscription).toEqual(["max", "pro"]);
    expect(metered).toEqual([...metered].sort());
    expect(metered).toEqual(["api", "cursor_api"]);
  });
});

describe("readFacetCounts", () => {
  const facetRow = (over: Record<string, unknown>) => ({
    dimension: "owner",
    value: "user-1",
    session_count: 1n,
    input_tokens: decimal("0"),
    output_tokens: decimal("0"),
    cache_read_tokens: decimal("0"),
    cache_write_tokens: decimal("0"),
    estimated_cost: decimal("0"),
    error_count: 0n,
    ...over,
  });

  it("carries the per-option sums the breakdowns publish, not just counts", async () => {
    queryRawTyped.mockResolvedValue([
      facetRow({
        session_count: 41n,
        input_tokens: decimal("9000"),
        output_tokens: decimal("450"),
        estimated_cost: decimal("3.25"),
        error_count: 2n,
      }),
    ]);
    const [row] = await readFacetCounts(WINDOW, EMPTY_USAGE_SQL_FACETS);
    // AgentSessionUsageByUser publishes these; an earlier revision of the
    // statement returned counts alone and silently dropped every _sum.
    expect(row).toMatchObject({
      sessionCount: 41,
      inputTokens: 9000,
      outputTokens: 450,
      estimatedCost: 3.25,
      errorCount: 2,
    });
  });

  it("maps each dimension and keeps null as a real option", async () => {
    queryRawTyped.mockResolvedValue([
      facetRow({ session_count: 41n }),
      facetRow({ dimension: "repository", value: null, session_count: 63n }),
    ]);
    const rows = await readFacetCounts(WINDOW, EMPTY_USAGE_SQL_FACETS);
    expect(rows.map((r) => [r.dimension, r.value, r.sessionCount])).toEqual([
      ["owner", "user-1", 41],
      // An unattributed repository is an option a reader can select, not noise.
      ["repository", null, 63],
    ]);
  });

  it("reads a null sum as a real zero, since the option exists at all", async () => {
    queryRawTyped.mockResolvedValue([
      facetRow({ session_count: 3n, estimated_cost: null }),
    ]);
    const [row] = await readFacetCounts(WINDOW, EMPTY_USAGE_SQL_FACETS);
    // Unlike the cost split, an option with no sum is not an absent population:
    // it exists because sessions produced it, and sessionCount says how many.
    expect(row?.estimatedCost).toBe(0);
    expect(row?.sessionCount).toBe(3);
  });

  it("drops a dimension the caller cannot handle rather than widening the type", async () => {
    queryRawTyped.mockResolvedValue([
      facetRow({}),
      facetRow({ dimension: "sasquatch", value: "x", session_count: 9n }),
    ]);
    const rows = await readFacetCounts(WINDOW, EMPTY_USAGE_SQL_FACETS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimension).toBe("owner");
  });

  it("forwards every facet array in the statement's parameter order", async () => {
    queryRawTyped.mockResolvedValue([]);
    await readFacetCounts(WINDOW, {
      ownerUserIds: ["u"],
      creatorUserIds: ["creator"],
      harnesses: ["claude"],
      repositories: ["o/r"],
      models: ["opus"],
      projectIds: ["p"],
      projectId: "own-project",
      completedAfter: new Date("2026-02-01T00:00:00.000Z"),
      teamId: "team",
      changePresence: ["has_changes"],
      prAssociation: ["no_pr"],
      autonomyLowerBounds: [8],
      autonomyUpperBounds: [Number.POSITIVE_INFINITY],
      autonomyIncludesNull: true,
      statuses: ["active"],
      qualityMode: "substantive",
      costBucketLowerBounds: [1.005],
      costBucketUpperBounds: [10.005],
      costBucketIncludesUnknown: true,
      subscriptionBillingModes: ["max"],
      priorityMembers: ["URGENT"],
      priorityIncludesUnset: true,
    });
    const [statement] = queryRawTyped.mock.calls[0] as [{ args: unknown[] }];
    // The WHOLE tuple, positionally. Every distinct value, so a transposition —
    // repositories landing in the harnesses slot — fails here rather than
    // becoming a card that filters on the wrong column. This order is the
    // contract four statements share; see the fragment headers in
    // packages/database/prisma/sql-fragments/.
    expect(statement.args).toEqual([
      WINDOW.organizationId,
      WINDOW.start,
      WINDOW.end,
      ["u"],
      new Date("2026-02-01T00:00:00.000Z"),
      ["o/r"],
      ["claude"],
      ["opus"],
      ["p"],
      "team",
      ["has_changes"],
      ["no_pr"],
      [8],
      [Number.POSITIVE_INFINITY],
      true,
      ["active"],
      "own-project",
      "substantive",
      [1.005],
      [10.005],
      true,
      ["max"],
      ["URGENT"],
      true,
      ["creator"],
    ]);
  });

  it("passes the same tuple to every statement that shares it", async () => {
    const facets = {
      ...EMPTY_USAGE_SQL_FACETS,
      repositories: ["o/r"],
      changePresence: ["has_changes"],
      // ISS-10150: a real, non-default value — "the same tuple" is not
      // provable at every position by narrowing on a facet this slot ignores.
      qualityMode: "substantive",
    } satisfies UsageSqlFacets;
    queryRawTyped.mockResolvedValue([]);
    await readUsageTotals(WINDOW, facets);
    await readFacetCounts(WINDOW, facets);
    await readMergedPrLoc(WINDOW, facets);
    await readLocCoverageCounts(WINDOW, facets);
    await readCostSplit(WINDOW, facets);
    const tuples = queryRawTyped.mock.calls.map(
      ([statement]) => (statement as { args: unknown[] }).args
    );
    // Cost split appends its own `meteredBillingModes` AFTER the shared
    // prefix, so it is compared on the prefix. A statement that stopped
    // taking a facet — the defect that had the cost card reporting unfiltered
    // spend beside filtered totals — shortens its tuple and fails here. The
    // prefix is 25 wide (ISS-10753 added the cost-bucket and shared
    // subscription-vocabulary slots; ISS-10332's two priority arms extended it
    // again, ISS-12251's creator scope once more) — a narrower bound would let a
    // statement-specific drift on one of those new slots pass unnoticed (whitlockk
    // on #7246).
    for (const args of tuples) {
      expect(args.length).toBeGreaterThanOrEqual(25);
      expect(args.slice(0, 25)).toEqual(tuples[0].slice(0, 25));
    }
    expect(tuples).toHaveLength(5);
  });
});

describe("readMergedPrLoc", () => {
  it("keeps a missing numerator null while counting the D4 exclusions", async () => {
    queryRawTyped.mockResolvedValue([
      {
        merged_pr_count: 3n,
        merged_loc: null,
        excluded_pr_count: 3n,
        median_pr_size: null,
      },
    ]);
    // Three merged PRs, all with unusable line counts. That is not "they
    // changed zero lines" — publishing a 0 LOC/$ ratio from it would be a lie,
    // and a median of 0 would be the same lie in a different column.
    await expect(
      readMergedPrLoc(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toEqual({
      mergedPrCount: 3,
      mergedLoc: null,
      excludedPrCount: 3,
      medianPrSize: null,
    });
  });

  it("coerces a bigint numerator, since additions/deletions are int columns", async () => {
    queryRawTyped.mockResolvedValue([
      {
        merged_pr_count: 2n,
        merged_loc: 1500n,
        excluded_pr_count: 0n,
        median_pr_size: 750,
      },
    ]);
    await expect(
      readMergedPrLoc(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toMatchObject({
      mergedLoc: 1500,
    });
  });

  it("passes the median through untouched — percentile_cont is already a number", async () => {
    queryRawTyped.mockResolvedValue([
      {
        merged_pr_count: 2n,
        merged_loc: 100n,
        excluded_pr_count: 0n,
        // The even-count interpolation percentile_cont performs and
        // percentile_disc does not. A fractional median is expected, not a bug.
        median_pr_size: 2.5,
      },
    ]);
    await expect(
      readMergedPrLoc(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toMatchObject({
      medianPrSize: 2.5,
    });
  });
});

describe("readLocCoverageCounts", () => {
  it("coerces all four counts", async () => {
    queryRawTyped.mockResolvedValue([
      {
        numerator_session_count: 12n,
        covered_numerator_session_count: 12n,
        migration_pending_session_count: 2n,
        unrevisioned_session_count: 1n,
      },
    ]);
    await expect(
      readLocCoverageCounts(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toEqual({
      numeratorSessionCount: 12,
      coveredNumeratorSessionCount: 12,
      migrationPendingSessionCount: 2,
      unrevisionedSessionCount: 1,
    });
  });

  it("reports zeros when no session carries a delivery link", async () => {
    // Distinct from a failed probe, which foldLocPerDollarCoverage represents
    // with a null it turns into the `failed` state — this is a measured empty
    // cohort, and the fold reads it as complete.
    queryRawTyped.mockResolvedValue([
      {
        numerator_session_count: 0n,
        covered_numerator_session_count: 0n,
        migration_pending_session_count: 0n,
        unrevisioned_session_count: 0n,
      },
    ]);
    await expect(
      readLocCoverageCounts(WINDOW, EMPTY_USAGE_SQL_FACETS)
    ).resolves.toMatchObject({
      numeratorSessionCount: 0,
    });
  });
});
