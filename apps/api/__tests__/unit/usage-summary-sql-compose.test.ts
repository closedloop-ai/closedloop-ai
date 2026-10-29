/**
 * ISS-9768 / ISS-9769 — the two WIRE-CONTRACT decisions in the composed summary.
 *
 * Both fields were briefly dropped or mis-gated as "decided removals", and both
 * decisions were wrong. They are also the two the shadow differ could not have
 * caught, because each was registered in `EXPECTED_MOVEMENT` at the same time,
 * which classifies a disagreement as expected. So the composer is driven here
 * directly rather than through the differ.
 *
 * The six readers are mocked at their module seam. This file is about what the
 * COMPOSER assembles from their results — running the real statements needs a
 * database and is ISS-9755.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocPerDollarBasis } from "@/app/agent-sessions/service/loc-per-dollar-basis";

const readUsageTotals = vi.fn();
const readCostSplit = vi.fn();
const readFacetCounts = vi.fn();
const readMergedPrLoc = vi.fn();
const readLocCoverageCounts = vi.fn();
const readLastSyncTargets = vi.fn();

// ISS-8962: mocking the six readers is NOT enough on its own. The composer wraps
// them in `withDb(() => Promise.all([...]))`, and `withDb` resolves a client
// BEFORE it invokes its callback — so the wrapper is a seventh seam, and leaving
// it real made this suite fail on missing IAM credentials wherever no database
// was reachable, which is not what "the readers are mocked" promises.
//
// The callback runs with a client that THROWS on any access rather than a bare
// `undefined`: nothing on this path touches Prisma directly today, and a future
// path that does should name itself here instead of reading a property off
// nothing and failing somewhere less obvious.
vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: <T>(fn: (db: unknown) => Promise<T> | T): Promise<T> =>
      Promise.resolve(
        fn(
          new Proxy(
            {},
            {
              get(_target, property) {
                throw new Error(
                  `unmocked Prisma access (db.${String(property)}) — mock the reader at its module seam rather than reaching a database`
                );
              },
            }
          )
        )
      ),
  };
});

vi.mock("@/app/agent-sessions/service/usage-sql-reader", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/agent-sessions/service/usage-sql-reader")
  >("@/app/agent-sessions/service/usage-sql-reader");
  return {
    ...actual,
    readUsageTotals,
    readCostSplit,
    readFacetCounts,
    readMergedPrLoc,
    readLocCoverageCounts,
    readLastSyncTargets,
  };
});

const { buildUsageSummaryFromSql } = await import(
  "@/app/agent-sessions/service/usage-summary-sql"
);

/**
 * ISS-10753: `buildUsageSummaryFromSql` returns the summary directly — there
 * is no longer a D13 cohort refusal to unwrap. Kept as a named wrapper so the
 * call sites below read the same as before.
 */
function composeSummary(
  usageInput: Parameters<typeof buildUsageSummaryFromSql>[0]
) {
  return buildUsageSummaryFromSql(usageInput);
}
// The SHARED emit helper both producers use. Asserting through it rather than
// naming the deprecated alias keeps `no-kloc-per-dollar-metric` pinned to the
// one module already allowlisted for it, and pins that the candidate assembles
// these four fields THROUGH that helper -- so the alias cannot be dropped again
// without the spread going with it. It does not pin that the two producers agree
// on the VALUES: they legitimately do not (see EXPECTED_MOVEMENT).
const { toDeliverySummaryFields } = await import(
  "@/app/agent-sessions/service/delivery-metrics"
);

/**
 * The divisor the fixtures above produce: the whole $100 of estimated cost, on
 * the one basis {@link resolveLocPerDollarCostBasis} resolves. Spelled out here
 * rather than re-derived from the composer so the expected shape is not built by
 * the code under test (ISS-9848).
 */
const COST_BASIS = {
  basis: LocPerDollarBasis.Total,
  costUsd: 100,
  excludedUsd: 0,
};

const input = {
  organizationId: "org-1",
  viewerId: "user-1",
  // TOTAL-cost basis, so the divisor is `estimatedCost` rather than the
  // API-billed slice — otherwise these fixtures divide by zero and every
  // ratio is null for a reason that has nothing to do with what is under test.
  locPerDollarTotalCostBasis: true,
  filters: {},
} as never;

/**
 * A cohort that HAS delivery-linked sessions. The distinction under test is
 * whether any of them sits behind a MERGED pull request, which is a different
 * question and lives on `readMergedPrLoc`.
 */
const COVERAGE_COUNTS_WITH_SESSIONS = {
  numeratorSessionCount: 7,
  coveredNumeratorSessionCount: 4,
  migrationPendingSessionCount: 0,
  unrevisionedSessionCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  readUsageTotals.mockResolvedValue({
    sessionCount: 10,
    earliestSessionAt: null,
    latestSessionAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 100,
  });
  // `unclassifiedCost`, not `unknownCost` — `toCostSplitFields` sums the three
  // ledgers into `totalEstimatedCost`, so a misnamed key silently makes the
  // divisor 0 and every ratio null for a reason unrelated to the test.
  readCostSplit.mockResolvedValue({
    subscriptionCost: 0,
    meteredCost: 100,
    unclassifiedCost: null,
  });
  readFacetCounts.mockResolvedValue([]);
  readLastSyncTargets.mockResolvedValue([]);
  readLocCoverageCounts.mockResolvedValue(COVERAGE_COUNTS_WITH_SESSIONS);
  readMergedPrLoc.mockResolvedValue({
    mergedPrCount: 3,
    mergedLoc: 5000,
    excludedPrCount: 0,
    medianPrSize: 100,
  });
});

describe("mergedKlocPerDollar — the compatibility alias (ISS-9769)", () => {
  it("is EMITTED, scaled down from the canonical LOC/$", async () => {
    // The cloud deploys ahead of installed Desktop builds. A pre-ISS-4667
    // Desktop reads this field, and its schema once REQUIRED it, so omitting it
    // fails that client's parse rather than degrading its render.
    const summary = await composeSummary(input);

    // Pinned against the FIXTURES, not fed back from the result: 5000 merged LOC
    // over 100 total cost is 50 LOC/$, so the alias is 0.05. Passing
    // `summary.mergedLocPerDollar` back in would make that key tautological and
    // leave only three of the four fields actually pinned (marisolashgrove on #6853).
    expect(summary.mergedLocPerDollar).toBeCloseTo(50, 10);
    // ISS-9848: spelled out, NOT re-derived through `toMergedLocPerDollarBasis`
    // — the spread below runs the same bridge the producer does, so on its own
    // it would agree with a renamed wire value instead of catching it. Same
    // "pinned against the fixtures, not fed back from the result" rule the
    // ratio above follows.
    expect(summary.mergedLocPerDollarBasis).toBe(
      "merged_lines_over_total_cost"
    );
    expect(summary).toMatchObject(
      toDeliverySummaryFields(
        { mergedPrCount: 3, medianPrSize: 100, mergedLocPerDollar: 50 },
        COST_BASIS
      )
    );
  });

  it("stays null when there is no LOC/$ to scale", async () => {
    // An unavailable ratio must not become a fabricated legacy number.
    readMergedPrLoc.mockResolvedValue({
      mergedPrCount: 3,
      mergedLoc: null,
      excludedPrCount: 2,
      medianPrSize: null,
    });

    const summary = await composeSummary(input);

    expect(summary.mergedLocPerDollar).toBeNull();
    // The alias stays null too — an unavailable ratio must not become a
    // fabricated legacy number.
    expect(summary).toMatchObject(
      toDeliverySummaryFields(
        { mergedPrCount: 3, medianPrSize: null, mergedLocPerDollar: null },
        COST_BASIS
      )
    );
  });
});

describe("mergedLocPerDollarCoverage — presence contract (ISS-9768)", () => {
  it("is ABSENT when no merged PR is in scope, even with linked sessions", async () => {
    // THE REGRESSION. The old gate read `numeratorSessionCount > 0` — delivery
    // links, merge state never consulted — so this case emitted a verdict about
    // merged work with no merged work behind it, and the verdict drives
    // `unavailableReason` on the LOC/$ card.
    readMergedPrLoc.mockResolvedValue({
      mergedPrCount: 0,
      mergedLoc: null,
      excludedPrCount: 0,
      medianPrSize: null,
    });
    readLocCoverageCounts.mockResolvedValue(COVERAGE_COUNTS_WITH_SESSIONS);

    const summary = await composeSummary(input);

    // ABSENT, never null — the cross-repo omit-don't-null rule, so an older
    // client's `undefined` check and the contract agree.
    expect(summary).not.toHaveProperty("mergedLocPerDollarCoverage");
  });

  it("is PRESENT when a merged PR is in scope", async () => {
    const summary = await composeSummary(input);

    expect(summary).toHaveProperty("mergedLocPerDollarCoverage");
    expect(summary.mergedLocPerDollarCoverage).toBeDefined();
  });

  it("does not consult WHEN the PR merged — existence only (D3)", async () => {
    // D3: the window applies to the session's last_activity_at; a PR's own
    // merged_at bounds nothing. `sessionMergedPrLoc.sql` already encodes this as
    // `p.merged_at IS NOT NULL`, so a merged PR from any time counts, and the
    // composer must not add a second, narrower notion of "recent enough".
    readMergedPrLoc.mockResolvedValue({
      mergedPrCount: 1,
      mergedLoc: 10,
      excludedPrCount: 0,
      medianPrSize: 10,
    });

    const summary = await composeSummary(input);

    expect(summary).toHaveProperty("mergedLocPerDollarCoverage");
  });
});
