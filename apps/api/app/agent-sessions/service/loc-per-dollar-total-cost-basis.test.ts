/**
 * ISS-6526 — the Sessions merged LOC/$ ratio divides in-window merged lines by
 * the in-window TOTAL session cost.
 *
 * Graded through `getUsageSummary`, the production composition root, so the
 * whole chain is on the path: the cost `groupBy` snapshot, its three-ledger
 * classification, the basis choice, the merge window, and the delivery engine.
 *
 * THE FIXTURE MAKES THE TWO BASES DIFFER. Subscription-covered spend is non-zero
 * and four times the metered ledger, so `totalEstimatedCost` and
 * `apiEstimatedCost` are different numbers. A fixture with no subscription
 * spend would let an API-cost denominator pass by coincidence.
 *
 * The expected ratios are pinned as INDEPENDENT LITERALS, arithmetic done here
 * once by hand rather than re-derived in the assertion from the same division
 * the production code performs.
 */
import { NormalizedPrState } from "@repo/api/src/insights/delivery-kpis/normalized-rows";
import {
  METERED_BILLING_MODES,
  SUBSCRIPTION_BILLING_MODES,
} from "@repo/api/src/types/billing-mode";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { MergedPrBranchAdmissionKind } from "@/lib/session-pr-links";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ORGANIZATION_ID = "org-6526";

/** The selected range. Both sides of the ratio must be bounded by exactly this. */
const START = "2026-07-01T00:00:00Z";
const END = "2026-07-31T23:59:59Z";

/** Subscription-covered spend: real dollars that bought real merged lines. */
const SUBSCRIPTION_COST = 90;
const METERED_COST = 30;
/** Hand-computed: the whole of the window's spend. */
const TOTAL_COST = 120;

/** Gross lines (additions + deletions) of the PR that merged INSIDE the range. */
const IN_WINDOW_LINES = 600;
/**
 * The PR that merged BEFORE the range. Deliberately huge and lopsided so a
 * numerator that lost its window cannot land on either expected ratio by
 * coincidence.
 */
const OUT_OF_WINDOW_ADDITIONS = 3000;

/** 600 gross lines ÷ $120 total spend. */
const EXPECTED_LOC_PER_DOLLAR_TOTAL_BASIS = 5;
const DENOMINATOR_SESSION_COUNT = 12;
const NUMERATOR_BRANCH_ID = "branch-artifact-in-window";
const NUMERATOR_PR_IDENTITY = "acme/repo#61";

/**
 * Billing modes read from the canonical sets: these are INPUTS the split
 * classifies, and a mode invented here would fall to `unknown`, land the
 * subscription dollars in the API ledger, and collapse the very difference this
 * suite measures.
 */
const [SUBSCRIPTION_MODE] = [...SUBSCRIPTION_BILLING_MODES];
const [METERED_MODE] = [...METERED_BILLING_MODES];

/**
 * Two merged PRs, one each side of the range bound. The row-prep read is stubbed
 * because this suite grades the DIVISION and its bounds, not which PRs qualify
 * (`agent-session-delivery-metrics.test.ts` owns admission).
 */
vi.mock("@/lib/agent-session-delivery-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/agent-session-delivery-metrics")
    >();
  const inWindowMergedAt = Date.parse("2026-07-15T00:00:00Z");
  const outOfWindowMergedAt = Date.parse("2026-06-15T00:00:00Z");
  return {
    ...actual,
    collectMergedPrsForScope: vi.fn(() =>
      Promise.resolve({
        prs: [
          {
            state: NormalizedPrState.Merged,
            createdAt: inWindowMergedAt,
            mergedAt: inWindowMergedAt,
            closedAt: null,
            additions: 400,
            deletions: 200,
            enriched: true,
            observedAt: inWindowMergedAt,
          },
          {
            state: NormalizedPrState.Merged,
            createdAt: outOfWindowMergedAt,
            mergedAt: outOfWindowMergedAt,
            closedAt: null,
            additions: OUT_OF_WINDOW_ADDITIONS,
            deletions: 0,
            enriched: true,
            observedAt: outOfWindowMergedAt,
          },
        ],
        mergedBranches: [
          {
            branchArtifactId: NUMERATOR_BRANCH_ID,
            mergedAtMs: inWindowMergedAt,
            admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
            prIdentity: NUMERATOR_PR_IDENTITY,
          },
        ],
      })
    ),
  };
});

/**
 * A fully-covered numerator cohort, so the coverage verdict below is decided by
 * the BASIS alone rather than by uncovered sessions outranking it.
 */
vi.mock("./loc-per-dollar-coverage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./loc-per-dollar-coverage")>();
  return {
    ...actual,
    readLocPerDollarCoverageCounts: vi.fn(() =>
      Promise.resolve({
        numeratorSessionCount: 3,
        coveredNumeratorSessionCount: 3,
        migrationPendingSessionCount: 0,
        unrevisionedSessionCount: 0,
      })
    ),
  };
});

function installCostSnapshot() {
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: DENOMINATOR_SESSION_COUNT },
        _sum: {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: TOTAL_COST,
        },
        _min: { sessionStartedAt: new Date(START) },
        _max: { sessionStartedAt: new Date(END) },
      }),
      groupBy: vi.fn().mockImplementation((args: { by: string[] }) => {
        if (args.by.includes("billingMode")) {
          return Promise.resolve([
            {
              legacyLoopCostLedger: null,
              billingMode: SUBSCRIPTION_MODE,
              _sum: { estimatedCost: SUBSCRIPTION_COST },
            },
            {
              legacyLoopCostLedger: null,
              billingMode: METERED_MODE,
              _sum: { estimatedCost: METERED_COST },
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

function readSummary() {
  return agentSessionsService.getUsageSummary({
    organizationId: ORGANIZATION_ID,
    filters: { startDate: START, endDate: END },
  });
}

describe("ISS-6526 — merged LOC/$ divides by the in-window TOTAL session cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCostSnapshot();
  });

  it("divides the in-window merged lines by the total estimated cost", async () => {
    const summary = await readSummary();

    expect(summary.mergedLocPerDollar).toBe(
      EXPECTED_LOC_PER_DOLLAR_TOTAL_BASIS
    );
    expect(summary.totalEstimatedCost).toBe(TOTAL_COST);
    expect(summary.apiEstimatedCost).toBe(METERED_COST);
  });

  it("keeps the numerator bounded by the SAME selected range as the divisor", async () => {
    const summary = await readSummary();

    // The out-of-window PR's 3,000 lines are excluded, so the numerator is the
    // 600 in-window lines only. A numerator that lost its window would divide
    // 3,600 by the same $120 and publish 30 — and the divisor is already proven
    // to be the windowed spend, so the two sides describe one range.
    expect(summary.mergedLocPerDollar).toBe(
      EXPECTED_LOC_PER_DOLLAR_TOTAL_BASIS
    );
    // The sibling delivery cards agree that only one PR is in range, which is
    // what makes the ratio above a windowed numerator rather than a lucky sum.
    expect(summary.mergedPrCount).toBe(1);
    expect(summary.medianPrSize).toBe(IN_WINDOW_LINES);
  });

  it("publishes the basis it divided by, so a skewed client is not left inferring it", async () => {
    const summary = await readSummary();

    // ISS-9848. Pinned to the literal wire token, not to the const the producer
    // reads: an assertion sourced from `MergedLocPerDollarBasis` would follow a
    // rename of the emitted string and stop being a wire-contract test.
    expect(summary.mergedLocPerDollarBasis).toBe(
      "merged_lines_over_total_cost"
    );
    // The basis and the divisor are the SAME decision, so they cannot disagree:
    // the ratio above is 600 lines over the full $120, not the $30 API slice.
    expect(summary.mergedLocPerDollar).toBe(
      EXPECTED_LOC_PER_DOLLAR_TOTAL_BASIS
    );
    // Omission, never `null` — an absent optional cross-repo field must not be
    // serialized, and JSON is the shape the client actually receives.
    expect(JSON.parse(JSON.stringify(summary)).mergedLocPerDollarBasis).toBe(
      "merged_lines_over_total_cost"
    );
  });

  it("reports nothing excluded from the basis, so the coverage gate stops declining the card", async () => {
    const summary = await readSummary();

    // The three ledgers partition the snapshot, so a divisor that sums all of
    // them leaves nothing out. A gate still reporting the subscription ledger as
    // excluded would caption this now-correct number Unavailable — the exact
    // production symptom (a 7d view with 320 PRs shipped rendering a dash).
    expect(summary.mergedLocPerDollarCoverage).toMatchObject({
      state: LocPerDollarCoverageState.Complete,
      costBasisCoveredUsd: TOTAL_COST,
      costBasisExcludedUsd: 0,
    });
  });
});
