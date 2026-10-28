/**
 * ISS-7705 AC2 — the LOC/$ coverage populations reach telemetry from the
 * PRODUCTION read.
 *
 * `loc-per-dollar-coverage.test.ts` grades the fold in isolation. This suite
 * grades the WIRING: that `buildUsageSummary` actually calls the probe, folds
 * it against the divisor it published, emits the four populations, and puts the
 * verdict on the wire. Without it, deleting the emission — or never calling the
 * probe at all — would leave the fold suite green.
 */
import {
  METERED_BILLING_MODES,
  SUBSCRIPTION_BILLING_MODES,
} from "@repo/api/src/types/billing-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
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

/**
 * One merged PR, so the scope is non-empty and the coverage probe runs at all.
 * The delivery row-prep is stubbed because this suite is about the COVERAGE
 * emission, not about which PRs qualify (`agent-session-delivery-metrics.test.ts`
 * owns that).
 */
vi.mock("@/lib/agent-session-delivery-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/agent-session-delivery-metrics")
    >();
  return {
    ...actual,
    collectMergedPrsForScope: vi.fn(() =>
      Promise.resolve(
        deliveryState.empty
          ? { prs: [], mergedBranches: [] }
          : {
              prs: [
                {
                  state: "merged",
                  createdAt: 0,
                  mergedAt: 0,
                  closedAt: null,
                  additions: 500,
                  deletions: 100,
                  enriched: true,
                  observedAt: 0,
                },
              ],
              mergedBranches: [
                {
                  branchArtifactId: "branch-1",
                  mergedAtMs: 0,
                  admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
                  prIdentity: "acme/repo#7",
                },
              ],
            }
      )
    ),
  };
});

/** Set to true to make the delivery read find no merged PR at all. */
const deliveryState = vi.hoisted(() => ({ empty: false }));

const coverageCounts = vi.hoisted(() => ({
  numeratorSessionCount: 6,
  coveredNumeratorSessionCount: 2,
  migrationPendingSessionCount: 0,
  unrevisionedSessionCount: 0,
}));

/** Set to true to make the probe report that it could not complete. */
const probeState = vi.hoisted(() => ({ failed: false }));

vi.mock("./loc-per-dollar-coverage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./loc-per-dollar-coverage")>();
  return {
    ...actual,
    readLocPerDollarCoverageCounts: vi.fn(() =>
      Promise.resolve(probeState.failed ? null : coverageCounts)
    ),
  };
});

/**
 * The metric name, written out independently of
 * `SESSIONS_LOC_PER_DOLLAR_COVERAGE_METRIC`. A monitor keys off this exact
 * string; importing the constant would make a rename pass silently here and
 * break the dashboard in production instead.
 */
const COVERAGE_METRIC = "agent_sessions.dashboard.loc_per_dollar_coverage";

const ORGANIZATION_ID = "org-7705";
const DENOMINATOR_SESSION_COUNT = 40;
/** Subscription-covered spend — real dollars the divisor's ledger leaves out. */
const SUBSCRIPTION_COST = 300;
/** The API-billed ledger the divisor is actually built from. */
const API_COST = 25;
const TOTAL_COST = SUBSCRIPTION_COST + API_COST;

/**
 * Billing modes read from the canonical sets rather than re-spelled here — these
 * are INPUTS the split classifies, not the contract under test, and AGENTS.md
 * requires fixtures to import an existing contract enum instead of repeating its
 * literals. A mode this suite invented would silently classify as `unknown` and
 * land the "subscription" dollars in the API ledger, which is exactly the
 * mis-attribution the assertions below are meant to catch.
 */
const [SUBSCRIPTION_MODE] = [...SUBSCRIPTION_BILLING_MODES];
const [METERED_MODE] = [...METERED_BILLING_MODES];

function installDbWithCohort() {
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
        _min: { sessionStartedAt: new Date(0) },
        _max: { sessionStartedAt: new Date(0) },
      }),
      // The cost split reads this `groupBy(legacyLoopCostLedger, billingMode)` snapshot.
      // A subscription row and a metered row, so `apiEstimatedCost` and
      // `subscriptionEstimatedCost` are both non-zero and distinguishable.
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
              _sum: { estimatedCost: API_COST },
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    loop: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

/** The one coverage emission from the last read, or `undefined`. */
function emittedCoverageMetric(): Record<string, unknown> | undefined {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .find((payload) => payload.metric === COVERAGE_METRIC);
}

describe("ISS-7705 AC2 — coverage populations exposed to telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveryState.empty = false;
    probeState.failed = false;
    coverageCounts.migrationPendingSessionCount = 0;
    coverageCounts.unrevisionedSessionCount = 0;
    coverageCounts.numeratorSessionCount = 6;
    coverageCounts.coveredNumeratorSessionCount = 2;
  });

  it("emits the numerator, denominator, excluded count and both sides of the cost basis", async () => {
    installDbWithCohort();

    await agentSessionsService.getUsageSummary({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    const emitted = emittedCoverageMetric();
    expect(emitted).toBeDefined();
    expect(emitted).toMatchObject({
      metric: COVERAGE_METRIC,
      organizationId: ORGANIZATION_ID,
      coverageState: "missing",
      numeratorSessionCount: 6,
      // The population the DIVISOR summed, not the numerator cohort.
      denominatorSessionCount: DENOMINATOR_SESSION_COUNT,
      // 6 numerator-bearing sessions, 2 of them in the divisor → 4 uncovered.
      excludedSessionCount: 4,
      costBasisCoveredUsd: TOTAL_COST,
      costBasisExcludedUsd: 0,
    });
  });

  it("publishes the verdict on the summary wire alongside the ratio", async () => {
    installDbWithCohort();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    expect(summary.mergedLocPerDollarCoverage).toMatchObject({
      state: "missing",
      excludedSessionCount: 4,
      costBasisExcludedUsd: 0,
    });
    // The ratio itself is UNCHANGED — the server still reports what it computed.
    // The gate is a render decision, so a flag-off client keeps today's number
    // and the signal still reaches the monitored path either way.
    expect(summary.mergedLocPerDollar).not.toBeNull();
  });

  it("still returns a usable summary, with the ratio declined, when the coverage probe fails", async () => {
    // A gate that only ever DECIDES WHETHER TO STATE ONE CARD must not get veto
    // power over the headline aggregates that already succeeded. And it must not
    // fall through to `complete` either — an unanswered coverage question is not
    // a clean bill of health.
    probeState.failed = true;
    installDbWithCohort();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    // The rest of the response survived.
    expect(summary.totalSessions).toBe(DENOMINATOR_SESSION_COUNT);
    expect(summary.totalEstimatedCost).toBe(TOTAL_COST);
    // And the verdict fails CLOSED.
    expect(summary.mergedLocPerDollarCoverage?.state).toBe("failed");
    expect(emittedCoverageMetric()).toMatchObject({
      coverageState: "failed",
    });
  });

  it("publishes NO verdict and emits nothing when the scope has no merged PRs to gate", async () => {
    // Absent is not `complete`. With no merged lines the ratio is null on its own
    // account, so asserting coverage nobody measured would be a fabricated clean
    // bill of health — and the probe must not spend a query establishing it.
    deliveryState.empty = true;
    installDbWithCohort();

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    // Omitted, never null — the cross-repo optional-field rule.
    expect(summary.mergedLocPerDollarCoverage).toBeUndefined();
    expect("mergedLocPerDollarCoverage" in summary).toBe(false);
    expect(emittedCoverageMetric()).toBeUndefined();
  });

  it("reports the staged-replacement verdict when a numerator session is mid-rebuild", async () => {
    coverageCounts.coveredNumeratorSessionCount = 6;
    coverageCounts.migrationPendingSessionCount = 1;
    installDbWithCohort();

    await agentSessionsService.getUsageSummary({
      organizationId: ORGANIZATION_ID,
      filters: {},
    });

    expect(emittedCoverageMetric()).toMatchObject({
      coverageState: "migration_pending",
      excludedSessionCount: 0,
    });
  });
});
