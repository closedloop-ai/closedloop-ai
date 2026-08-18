import { GitHubPRState } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
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
 * FEA-3156 / FEA-4295 / ISS-4667 — the Sessions top-row DELIVERY summary
 * (`mergedPrCount`, `medianPrSize`, `mergedLocPerDollar` + its deprecated KLOC/$
 * alias) as served by `agentSessionsService.getUsageSummary`. Split out of
 * `analytics-aggregation.test.ts` (ISS-4667) so the delivery cards' reconciliation
 * contract — which lines the ratio divides cost into, and when a card is
 * legitimately unavailable rather than zero — reads as one suite.
 */
describe("agentSessionsService delivery summary metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns delivery metrics for a matched session set with merged PRs", async () => {
    // A merged PR linked to a matched session, carrying line-diff facts. The
    // session→PR link is what brings the PR into the delivery scope; the PR's
    // own row (below, via `pullRequestDetail.findMany`) carries the facts —
    // additions + deletions are the gross lines the SSOT medians / sums into KLOC.
    function mergedPrLink(
      number: number,
      additions: number,
      deletions: number
    ) {
      return {
        targetId: `branch-${number}`,
        target: {
          branch: {
            currentPullRequestDetail: {
              number,
              prState: GitHubPRState.Merged,
              mergedAt: new Date("2026-03-10T10:00:00.000Z"),
              additions,
              deletions,
              isCurrent: true,
              repositoryFullName: "closedloop-ai/symphony-alpha",
              repository: { fullName: "closedloop-ai/symphony-alpha" },
            },
          },
        },
      };
    }
    function deliverySessionRecord(
      artifactId: string,
      estimatedCost: number,
      links: unknown[]
    ) {
      return {
        artifactId,
        sessionStartedAt: new Date("2026-03-01T10:00:00.000Z"),
        estimatedCost,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        artifact: { sourceLinks: links },
      };
    }

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            // Total cost across the 2 matched sessions = $2. Two merged PRs of
            // 1000 + 3000 gross lines → KLOC = 4.0; locPerDollar = 4 / 2 = 2.
            estimatedCost: 2,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          // Fourth call: headline cost split. All $2 of matched-session cost is
          // API-billed (DESKTOP_SYNC, api billingMode).
          .mockResolvedValueOnce([
            {
              sourceLoopId: null,
              billingMode: "api",
              _sum: { estimatedCost: 2 },
            },
          ])
          // Fifth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
        // The matched sessions themselves (cost + attribution lenses); each
        // links one of the merged PRs below.
        findMany: vi
          .fn()
          .mockResolvedValue([
            deliverySessionRecord("session-1", 1, [mergedPrLink(11, 600, 400)]),
            deliverySessionRecord("session-2", 1, [
              mergedPrLink(12, 2000, 1000),
            ]),
          ]),
      }),
      // ISS-6028: the delivery metrics read the merged PRs from the PR side,
      // semi-joined back through those links. Two PRs: 1000 and 3000 gross lines.
      pullRequestDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            mergedPrRow(
              { number: 11, branchArtifactId: "branch-11" },
              600,
              400
            ),
            mergedPrRow(
              { number: 12, branchArtifactId: "branch-12" },
              2000,
              1000
            ),
          ]),
      },
      // The delivery adapter probes for session→PR links before reading merged
      // PRs (so a broad no-PR-link dashboard never scans rows); this matched set
      // carries links, so the probe must resolve truthy.
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    // Two distinct merged PRs → count 2. Median gross lines over [1000, 3000] =
    // 2000. LOC (sum 4000 gross lines) ÷ cost ($2) = 2000 LOC/$ (ISS-4667: no
    // divide-by-1000).
    expect(summary.mergedPrCount).toBe(2);
    expect(summary.medianPrSize).toBe(2000);
    expect(summary.mergedLocPerDollar).toBe(2000);
    // ISS-4667 version-skew EMIT: the deprecated `mergedKlocPerDollar` alias is
    // emitted alongside (LOC/$ ÷ 1000 = 2) so a pre-ISS-4667 desktop reading that
    // field still gets the value instead of falling to a neutral dash.
    expect(summary.mergedKlocPerDollar).toBe(2);
  });
  it("excludes subscription-covered cost from the KLOC-per-$ denominator", async () => {
    // FEA-3156 (Codex P1): a subscription-billed session must NOT contribute to
    // the delivery Cost KPI (billing-mode contract). Here ALL $2 of matched
    // cost is subscription-covered, so the KLOC/$ denominator is $0 → the metric
    // is unavailable (null) even though a merged PR exists — the raw aggregate
    // total ($2) must never leak in as spend.
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 1 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            // Raw aggregate cost = $2 (all subscription-covered below).
            estimatedCost: 2,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          // Headline cost split: the whole $2 is DESKTOP_SYNC on a
          // subscription/seat billingMode → subscription cost, $0 API cost.
          .mockResolvedValueOnce([
            {
              sourceLoopId: null,
              billingMode: "max_20x",
              _sum: { estimatedCost: 2 },
            },
          ])
          // Fifth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
        // The matched session, linking the merged PR read below.
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "session-1",
            sessionStartedAt: new Date("2026-03-01T10:00:00.000Z"),
            estimatedCost: 2,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            artifact: {
              sourceLinks: [
                {
                  targetId: "branch-1",
                  target: {
                    branch: {
                      currentPullRequestDetail: {
                        number: 1,
                        prState: GitHubPRState.Merged,
                        mergedAt: new Date("2026-03-10T10:00:00.000Z"),
                        additions: 600,
                        deletions: 400,
                        isCurrent: true,
                        repositoryFullName: "closedloop-ai/symphony-alpha",
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ]),
      }),
      // A merged PR is linked, so mergedPrCount/medianPrSize still resolve —
      // only LOC/$ is null because the API-billed denominator is $0.
      pullRequestDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            mergedPrRow({ number: 1, branchArtifactId: "branch-1" }, 600, 400),
          ]),
      },
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    // The subscription session's $2 is reported as subscription spend, never as
    // API spend, and the LOC/$ card is unavailable because the denominator
    // (API-billed cost) is $0 — the merged PR alone cannot fabricate a ratio.
    expect(summary.subscriptionEstimatedCost).toBe(2);
    expect(summary.apiEstimatedCost).toBe(0);
    expect(summary.mergedPrCount).toBe(1);
    expect(summary.medianPrSize).toBe(1000);
    expect(summary.mergedLocPerDollar).toBeNull();
    // ISS-4667 EMIT: an unavailable LOC/$ must NOT be scaled into a fabricated
    // legacy number — the deprecated alias stays null, not 0.
    expect(summary.mergedKlocPerDollar).toBeNull();
  });
  it("nulls all three delivery metrics (incl. mergedPrCount) when no merged PRs are linked", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 1 },
          _sum: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 1,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          // Fifth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
        // A matched session with an OPEN (not merged) linked PR — no merged PR
        // to count, so all three delivery metrics (count, size, efficiency) are
        // genuinely unavailable (null). `mergedPrCount` must NOT be a fabricated
        // `0` here (data-honesty, FEA-3574 / wongk): the PRs Shipped card would
        // otherwise render a real "0" while its sibling cards dash on the same
        // absent data.
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "session-1",
            sessionStartedAt: new Date("2026-03-01T10:00:00.000Z"),
            estimatedCost: 1,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            artifact: {
              sourceLinks: [
                {
                  targetId: "branch-1",
                  target: {
                    branch: {
                      currentPullRequestDetail: {
                        number: 1,
                        prState: GitHubPRState.Open,
                        mergedAt: null,
                        additions: 100,
                        deletions: 50,
                        isCurrent: true,
                        repositoryFullName: "closedloop-ai/symphony-alpha",
                        repository: {
                          fullName: "closedloop-ai/symphony-alpha",
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        ]),
      }),
      // ISS-6028: the merged-PR predicate is applied by the read itself
      // (MERGED_PR_DETAIL_WHERE), so the linked OPEN PR is never returned — the
      // delivery cards resolve on an empty merged population.
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
      // A session→PR link exists (an OPEN PR), so the delivery adapter's probe
      // passes and it reads the linked merged PRs — of which there are none.
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    expect(summary.mergedPrCount).toBeNull();
    expect(summary.medianPrSize).toBeNull();
    expect(summary.mergedLocPerDollar).toBeNull();
  });
  it("counts two null-repo merged PRs sharing #42 as 2, not deduped to 1", async () => {
    // FEA-3156 dedup-by-nullable guard: two DISTINCT merged PRs on different
    // branches, both numbered 42, both with an unidentifiable repository (null
    // repositoryFullName + null repository relation). The old repo#number key
    // folded them into one `#42` bucket and dropped one from BOTH the count and
    // the median. Keyed by the branch artifact id, they stay two separate PRs.
    function nullRepoMergedPrLink(
      branchId: string,
      additions: number,
      deletions: number
    ) {
      return {
        targetId: branchId,
        target: {
          branch: {
            currentPullRequestDetail: {
              number: 42,
              prState: GitHubPRState.Merged,
              mergedAt: new Date("2026-03-10T10:00:00.000Z"),
              additions,
              deletions,
              isCurrent: true,
              repositoryFullName: null,
              repository: null,
            },
          },
        },
      };
    }

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            // $2 total, all API-billed below → KLOC/$ denominator = $2.
            estimatedCost: 2,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              sourceLoopId: null,
              billingMode: "api",
              _sum: { estimatedCost: 2 },
            },
          ])
          // Fifth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
        // Two matched sessions, each linking a distinct null-repo PR #42 on its
        // own branch: 1000 gross lines and 3000 gross lines.
        findMany: vi.fn().mockResolvedValue([
          {
            artifactId: "session-1",
            sessionStartedAt: new Date("2026-03-01T10:00:00.000Z"),
            estimatedCost: 1,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            artifact: {
              sourceLinks: [nullRepoMergedPrLink("branch-a", 600, 400)],
            },
          },
          {
            artifactId: "session-2",
            sessionStartedAt: new Date("2026-03-01T10:00:00.000Z"),
            estimatedCost: 1,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            artifact: {
              sourceLinks: [nullRepoMergedPrLink("branch-b", 2000, 1000)],
            },
          },
        ]),
      }),
      // The two PRs as the delivery read returns them: same number, no repo
      // identity, each current for its OWN linked branch artifact — which is the
      // identity component that keeps them apart.
      pullRequestDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            mergedPrRow(
              { number: 42, branchArtifactId: "branch-a", repo: null },
              600,
              400
            ),
            mergedPrRow(
              { number: 42, branchArtifactId: "branch-b", repo: null },
              2000,
              1000
            ),
          ]),
      },
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    // Both PRs survive: count 2 (not collapsed to 1), median over [1000, 3000] =
    // 2000, and LOC (4000 gross lines) ÷ cost ($2) = 2000 LOC/$.
    expect(summary.mergedPrCount).toBe(2);
    expect(summary.medianPrSize).toBe(2000);
    expect(summary.mergedLocPerDollar).toBe(2000);
  });
});

/**
 * ISS-6398 — the LOC/$ (merged) denominator must be the spend of the SELECTED
 * window, not the org's all-time spend.
 *
 * The delivery scope deliberately strips the session-activity date window so an
 * older-than-window session's in-window merge still reaches the merged-PR
 * NUMERATOR (FEA-4295). The cost denominator used to be re-derived over that same
 * stripped scope, which made the ratio "lines merged in the last 7 days ÷ every
 * dollar ever spent" — reported understated by ~517x on a 7-day window.
 *
 * The seed below is the reported shape: an org that has spent $2,000 all-time but
 * only $4 inside the selected window ($1 metered + $3 unknown), with 4,000 gross
 * lines merged in that window. The honest answer is 1,000 LOC/$; the pre-fix
 * answer was 2.
 */
describe("ISS-6398 — LOC/$ (merged) divides by in-window cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const WINDOW_START = "2026-03-01T00:00:00.000Z";
  const WINDOW_END = "2026-03-31T23:59:59.000Z";
  /** In-window spend on a CONFIRMED metered billing mode (ISS-4773 metered ledger). */
  const IN_WINDOW_METERED_COST = 1;
  /**
   * In-window spend whose billing mode could not be determined (ISS-4773 unknown
   * ledger). Seeded non-zero, and deliberately NOT equal to the metered figure: the
   * LOC/$ divisor is the not-subscription-covered bucket (`metered + unknown`), so
   * an all-metered (or symmetric) fixture would make `meteredEstimatedCost` and
   * `apiEstimatedCost` numerically indistinguishable and a divisor silently read
   * from the narrower bucket would still pass.
   */
  const IN_WINDOW_UNKNOWN_COST = 3;
  /** What the divisor must be: metered + unknown, i.e. `apiEstimatedCost`. */
  const IN_WINDOW_API_COST = IN_WINDOW_METERED_COST + IN_WINDOW_UNKNOWN_COST;
  /** API-billed spend of the same facet scope with the date window stripped. */
  const ALL_TIME_COST = 2000;

  /**
   * True when `where` carries the Sessions date window. `applyDateFilter` writes
   * it as an `OR` over `lastActivityAt` (with the pre-backfill
   * `sessionStartedAt` fallback), so its presence is what distinguishes the
   * windowed summary scope from the date-window-stripped delivery scope.
   */
  function isDateWindowed(where: unknown): boolean {
    const clauses = (where as { OR?: unknown }).OR;
    return (
      Array.isArray(clauses) &&
      clauses.some((clause) => "lastActivityAt" in (clause as object))
    );
  }

  it("divides merged lines by the in-window spend, not the all-time spend", async () => {
    // One `sessionDetail.groupBy` mock for every call, answering from the `where`
    // rather than from call order: the cost split reports $2 for the windowed
    // scope and $2,000 for the stripped one. A denominator taken from the wrong
    // scope therefore changes the ASSERTED RATIO, not just a call count.
    const groupBy = vi.fn((args: { by: string[]; where?: unknown }) => {
      if (!args.by.includes("sourceLoopId")) {
        return Promise.resolve([]);
      }
      if (!isDateWindowed(args.where)) {
        return Promise.resolve([
          {
            sourceLoopId: null,
            billingMode: "api",
            _sum: { estimatedCost: ALL_TIME_COST },
          },
        ]);
      }
      return Promise.resolve([
        {
          sourceLoopId: null,
          billingMode: "api",
          _sum: { estimatedCost: IN_WINDOW_METERED_COST },
        },
        // A legacy-null billing mode → the ISS-4773 UNKNOWN ledger.
        {
          sourceLoopId: null,
          billingMode: null,
          _sum: { estimatedCost: IN_WINDOW_UNKNOWN_COST },
        },
      ]);
    });

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 1 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            estimatedCost: IN_WINDOW_API_COST,
          },
          _min: { sessionStartedAt: new Date(WINDOW_START) },
          _max: { sessionStartedAt: new Date(WINDOW_START) },
        }),
        groupBy,
      }),
      // 1000 + 3000 = 4000 gross lines, both merged inside the window.
      pullRequestDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            mergedPrRow(
              { number: 11, branchArtifactId: "branch-11" },
              600,
              400
            ),
            mergedPrRow(
              { number: 12, branchArtifactId: "branch-12" },
              2000,
              1000
            ),
          ]),
      },
      artifactLink: { findFirst: vi.fn().mockResolvedValue({ id: "link-1" }) },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { startDate: WINDOW_START, endDate: WINDOW_END },
    });

    // 4000 gross lines ÷ $4 in-window API-billed = 1000 LOC/$. Dividing by the
    // $2,000 all-time spend instead yields 2 — the reported defect.
    expect(summary.mergedLocPerDollar).toBe(1000);
    // …and the denominator is the SAME in-window figure the summary publishes as
    // `apiEstimatedCost`. Reading the narrower `meteredEstimatedCost` bucket
    // instead would drop the unknown ledger — which ISS-4900 records as the
    // dominant share on subscription-heavy accounts — and inflate the ratio to
    // 4000. (`apiEstimatedCost` is what the Cost card headlines only with the
    // ISS-4773 honesty flag OFF; with it on the card shows the metered half, so
    // the two tiles are not expected to multiply out.)
    expect(summary.apiEstimatedCost).toBe(IN_WINDOW_API_COST);
    expect(summary.meteredEstimatedCost).toBe(IN_WINDOW_METERED_COST);
    // No cost aggregate ran over a date-window-stripped scope at all: the
    // all-time $2,000 snapshot above is unreachable, so the ratio cannot fall
    // back to it. (The stripped delivery scope still drives the merged-PR
    // NUMERATOR — that read is `pullRequestDetail.findMany`, not a cost groupBy.)
    const costCalls = groupBy.mock.calls.filter(([args]) =>
      args.by.includes("sourceLoopId")
    );
    expect(costCalls.length).toBeGreaterThan(0);
    expect(costCalls.every(([args]) => isDateWindowed(args.where))).toBe(true);
  });
});

/**
 * One merged-PR row as the delivery read returns it (ISS-6028): the PR's own
 * scalars plus the LINKED branch artifacts it is the current PR of. The read
 * applies the merged predicate itself, so every row here is a current, merged PR
 * — an unmerged one simply never comes back.
 */
function mergedPrRow(
  pr: { number: number; branchArtifactId: string; repo?: string | null },
  additions: number,
  deletions: number
) {
  const repositoryFullName =
    pr.repo === undefined ? "closedloop-ai/symphony-alpha" : pr.repo;
  return {
    number: pr.number,
    prState: GitHubPRState.Merged,
    mergedAt: new Date("2026-03-10T10:00:00.000Z"),
    additions,
    deletions,
    isCurrent: true,
    repositoryFullName,
    repository: repositoryFullName ? { fullName: repositoryFullName } : null,
    currentForBranches: [{ artifactId: pr.branchArtifactId }],
  };
}
