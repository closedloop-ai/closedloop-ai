/**
 * ISS-10867 — the SQL-candidate's prior comparison window can be pinned to a
 * caller-supplied window instead of re-resolving it from `now()`.
 *
 * WHY THIS EXISTS. `resolvePriorUsageWindow` truncates a rolling window's prior
 * end to `Math.min(endDate, now)`. The shadow comparison calls this path
 * strictly AFTER the live path already resolved its own prior window from an
 * earlier `now()` — see `usage-summary-shadow.test.ts` for the wiring that
 * hands the live-resolved window over. This file pins the READER half, across
 * all three states the parameter has: given a window, `readComparison` must use
 * it verbatim — for the READS, not merely for the echoed response fields —
 * rather than re-deriving one; given an explicit `null`, it must produce no
 * comparison and issue no prior read; and given no argument at all, it must
 * fall back to today's exact behavior.
 *
 * The six readers are mocked at their module seam, same as
 * `usage-summary-sql-compose.test.ts` — running the real statements needs a
 * database.
 */

import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readUsageTotals = vi.fn();
const readCostSplit = vi.fn();
const readFacetCounts = vi.fn();
const readMergedPrLoc = vi.fn();
const readLocCoverageCounts = vi.fn();
const readLastSyncTargets = vi.fn();

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
const { resolvePriorUsageWindow } = await import(
  "@/app/agent-sessions/service/usage-comparison"
);

/**
 * ISS-10753 removed the D13 cohort cap, so `buildUsageSummaryFromSql` returns
 * the summary directly — no `Result` to unwrap.
 */
function composeSummary(
  usageInput: Parameters<typeof buildUsageSummaryFromSql>[0],
  priorWindowOverride?: Parameters<typeof buildUsageSummaryFromSql>[1]
) {
  return buildUsageSummaryFromSql(usageInput, priorWindowOverride);
}

/**
 * A window fully in the past, so `resolvePriorUsageWindow`'s natural
 * resolution is deterministic (`elapsedEndMs = endMs`, never `now()`) and this
 * suite needs no fake timer to pin it.
 */
const CURRENT_START = "2020-01-01T00:00:00.000Z";
const CURRENT_END = "2020-01-08T00:00:00.000Z";

const input = {
  organizationId: "org-1",
  viewerId: "user-1",
  filters: {
    comparison: AgentSessionComparisonMode.Prior,
    startDate: CURRENT_START,
    endDate: CURRENT_END,
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  const totals = {
    sessionCount: 10,
    earliestSessionAt: null,
    latestSessionAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 100,
  };
  const cost = {
    subscriptionCost: 0,
    meteredCost: 100,
    unclassifiedCost: null,
  };
  const mergedPr = {
    mergedPrCount: 3,
    mergedLoc: 5000,
    excludedPrCount: 0,
    medianPrSize: 100,
  };
  // Same fixture for every call: `readComparison` reads these again for the
  // PRIOR window, and this suite is about which window it asked for, not about
  // the current-vs-prior arithmetic (that is `usage-comparison.test.ts`'s job).
  readUsageTotals.mockResolvedValue(totals);
  readCostSplit.mockResolvedValue(cost);
  readMergedPrLoc.mockResolvedValue(mergedPr);
  readFacetCounts.mockResolvedValue([]);
  readLastSyncTargets.mockResolvedValue([]);
  readLocCoverageCounts.mockResolvedValue({
    numeratorSessionCount: 0,
    coveredNumeratorSessionCount: 0,
    migrationPendingSessionCount: 0,
    unrevisionedSessionCount: 0,
  });
});

describe("readComparison's prior window — override vs natural resolution", () => {
  it("resolves its own window when no override is supplied (today's behavior)", async () => {
    const summary = await composeSummary(input);
    const natural = resolvePriorUsageWindow(CURRENT_START, CURRENT_END);
    expect(natural).not.toBeNull();

    expect(summary.comparison?.priorStartDate).toBe(natural?.startDate);
    expect(summary.comparison?.priorEndDate).toBe(natural?.endDate);
  });

  it("uses the override VERBATIM instead of re-resolving from now()", async () => {
    // Deliberately a different YEAR from what `resolvePriorUsageWindow` would
    // naturally compute for this input (late December 2019) — so a passing
    // assertion can only mean the override was honored, not a coincidence.
    const override = {
      startDate: "2019-06-01T00:00:00.000Z",
      endDate: "2019-06-08T00:00:00.000Z",
    };
    const natural = resolvePriorUsageWindow(CURRENT_START, CURRENT_END);
    expect(override.startDate).not.toBe(natural?.startDate);

    const summary = await composeSummary(input, override);

    // THE READ, not just the echo. `priorStartDate`/`priorEndDate` come straight
    // back out of `foldUsageComparison({ priorWindow, ... })`, so asserting only
    // those leaves green the exact defect this change exists to kill: a window
    // published on the wire that the AGGREGATION never used. Pinning the second
    // `readUsageTotals` call — the prior-window one; the first is the current
    // window — is what fails when `priorSqlWindow` is still built from
    // `resolvePriorUsageWindow` (marisolashgrove on #7751).
    expect(readUsageTotals).toHaveBeenCalledTimes(2);
    const priorSqlWindow = readUsageTotals.mock.calls[1][0];
    expect(priorSqlWindow.start.toISOString()).toBe(override.startDate);
    // `toExclusiveEnd`: the inclusive bound plus one millisecond.
    expect(priorSqlWindow.end.toISOString()).toBe("2019-06-08T00:00:00.001Z");

    expect(summary.comparison?.priorStartDate).toBe(override.startDate);
    expect(summary.comparison?.priorEndDate).toBe(override.endDate);
  });

  /**
   * The ABSENT half of the handoff, and why it is `null` rather than a missing
   * argument. `resolvePriorUsageWindow` stays `now()`-dependent at one edge —
   * it returns null while `now` is still before `startDate` — so a range that
   * OPENS between the live read and the shadow build would leave live with no
   * comparison and a re-resolving candidate with one, and the differ reports
   * the whole `comparison` field as a defect. An explicit `null` is the shadow
   * saying "live resolved one and got nothing" (whitlockk on #7751).
   */
  it("produces no comparison for an explicit null, without re-resolving one", async () => {
    const natural = resolvePriorUsageWindow(CURRENT_START, CURRENT_END);
    expect(natural).not.toBeNull();

    const summary = await composeSummary(input, null);

    expect(summary.comparison).toBeUndefined();
    // The prior reads never ran — only the current window was read. Without
    // this, the assertion above would also pass on a candidate that resolved
    // and read a prior window and then dropped it on the floor.
    expect(readUsageTotals).toHaveBeenCalledTimes(1);
  });

  it("still reports undefined comparison when the caller did not opt in, override or not", async () => {
    const noComparisonInput = {
      organizationId: "org-1",
      viewerId: "user-1",
      filters: { startDate: CURRENT_START, endDate: CURRENT_END },
    } as never;

    const summary = await composeSummary(noComparisonInput, {
      startDate: "2019-06-01T00:00:00.000Z",
      endDate: "2019-06-08T00:00:00.000Z",
    });

    // An override is not itself an opt-in — `input.filters.comparison` still
    // gates whether a comparison runs at all, same as before this change.
    expect(summary).not.toHaveProperty("comparison");
  });
});
