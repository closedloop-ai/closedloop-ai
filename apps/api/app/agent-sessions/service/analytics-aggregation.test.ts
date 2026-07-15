import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SESSION_PR_PURPOSE_LABELS,
  SessionPrPurpose,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../service";
import {
  buildAgentSessionDbMock,
  buildAnalyticsJsonRecord,
  buildAnalyticsScalarRecord,
  buildAttributionLensRecord,
  buildPersistedAgent,
  buildPersistedEvent,
  installDb,
  lowConfidenceBranch,
  referencedBranch,
  staleBranch,
  trustedBranch,
} from "../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("splits usage summary costs by linked loop apiKeySource", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 4 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            estimatedCost: 1.5,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-14T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            {
              userId: "user-1",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                estimatedCost: 1.5,
              },
            },
          ])
          .mockResolvedValueOnce([
            {
              harness: "claude",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                estimatedCost: 1.5,
              },
            },
          ])
          .mockResolvedValueOnce([
            {
              repositoryFullName: "acme/web",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                estimatedCost: 1.5,
                errorCount: 1,
              },
            },
            {
              repositoryFullName: null,
              _count: { _all: 1 },
              _sum: {
                inputTokens: 0,
                outputTokens: 0,
                estimatedCost: 0,
                errorCount: 0,
              },
            },
          ])
          // Fourth sessionDetail.groupBy call: cost split grouped by
          // sourceLoopId and billingMode. Loop-originated rows are classified by
          // the loop's apiKeySource; DESKTOP_SYNC rows (null sourceLoopId) are
          // classified by their synced billingMode — a subscription/seat mode
          // counts toward subscription cost, anything else toward API cost.
          // Binary-exact values so the subscription/API sums compare equal under
          // toEqual without floating-point drift.
          .mockResolvedValueOnce([
            {
              sourceLoopId: "loop-subscription",
              billingMode: null,
              _sum: { estimatedCost: 0.5 },
            },
            {
              sourceLoopId: "loop-api",
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
            // DESKTOP_SYNC, subscription/seat billingMode → subscription cost.
            {
              sourceLoopId: null,
              billingMode: "pro",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, API billingMode → API cost.
            {
              sourceLoopId: null,
              billingMode: "api",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, legacy null billingMode → API cost.
            {
              sourceLoopId: null,
              billingMode: null,
              _sum: { estimatedCost: 0.125 },
            },
            {
              sourceLoopId: "loop-missing",
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
          ]),
      }),
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([
          {
            model: "claude-sonnet-4",
            _count: { _all: 4 },
            _sum: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              estimatedCost: 1.5,
            },
          },
        ]),
      },
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
        ]),
      },
      loop: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "loop-subscription",
            metadata: { apiKeySource: "none" },
          },
          {
            id: "loop-api",
            metadata: { apiKeySource: "organization" },
          },
        ]),
      },
    });

    await expect(
      agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual(
      expect.objectContaining({
        totalEstimatedCost: 1.5,
        subscriptionEstimatedCost: 0.625,
        apiEstimatedCost: 0.75,
        earliestSessionAt: "2026-03-01T10:00:00.000Z",
        latestSessionAt: "2026-03-14T10:00:00.000Z",
        // Repository facet feed: the null-repo group is dropped, leaving only
        // the attributed repository.
        byRepository: [
          expect.objectContaining({
            repositoryFullName: "acme/web",
            sessionCount: 4,
            errorCount: 1,
          }),
        ],
      })
    );
  });
  it("returns delivery metrics for a matched session set with merged PRs", async () => {
    // A merged PR linked to a matched session, carrying line-diff facts. The
    // sessionMetricSelect (agent-session-delivery-metrics) reads the branch's
    // currentPullRequestDetail — prState/mergedAt gate "merged", additions +
    // deletions are the gross lines the SSOT medians / sums into KLOC.
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
            // 1000 + 3000 gross lines → KLOC = 4.0; klocPerDollar = 4 / 2 = 2.
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
          // Fourth call: cost split. All $2 of matched-session cost is
          // API-billed (DESKTOP_SYNC, api billingMode), so it is the KLOC/$
          // denominator in full.
          .mockResolvedValueOnce([
            {
              sourceLoopId: null,
              billingMode: "api",
              _sum: { estimatedCost: 2 },
            },
          ]),
        // The delivery-metrics pager reads the matched sessions + their linked
        // merged PRs. Two sessions: one 1000-line PR, one 3000-line PR.
        findMany: vi
          .fn()
          .mockResolvedValue([
            deliverySessionRecord("session-1", 1, [mergedPrLink(11, 600, 400)]),
            deliverySessionRecord("session-2", 1, [
              mergedPrLink(12, 2000, 1000),
            ]),
          ]),
      }),
      // The delivery adapter probes for session→PR links before paging merged
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
    // 2000. KLOC (sum 4000 / 1000) ÷ cost ($2) = 2.
    expect(summary.mergedPrCount).toBe(2);
    expect(summary.medianPrSize).toBe(2000);
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
          // Cost split: the whole $2 is DESKTOP_SYNC on a subscription/seat
          // billingMode → subscription cost, $0 API cost.
          .mockResolvedValueOnce([
            {
              sourceLoopId: null,
              billingMode: "max_20x",
              _sum: { estimatedCost: 2 },
            },
          ]),
        // A merged PR is linked, so mergedPrCount/medianPrSize still resolve —
        // only KLOC/$ is null because the API-billed denominator is $0.
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
    // API spend, and the KLOC/$ card is unavailable because the denominator
    // (API-billed cost) is $0 — the merged PR alone cannot fabricate a ratio.
    expect(summary.subscriptionEstimatedCost).toBe(2);
    expect(summary.apiEstimatedCost).toBe(0);
    expect(summary.mergedPrCount).toBe(1);
    expect(summary.medianPrSize).toBe(1000);
    expect(summary.mergedKlocPerDollar).toBeNull();
  });
  it("nulls delivery size/efficiency metrics when no merged PRs are linked", async () => {
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
          .mockResolvedValueOnce([]),
        // A matched session with an OPEN (not merged) linked PR — no merged PR
        // to count, so size + efficiency are genuinely unavailable (null) while
        // the count is a real 0.
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
      // A session→PR link exists (an OPEN PR), so the delivery adapter's probe
      // passes and it pages the linked PRs — none of which are merged.
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

    expect(summary.mergedPrCount).toBe(0);
    expect(summary.medianPrSize).toBeNull();
    expect(summary.mergedKlocPerDollar).toBeNull();
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
          ]),
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
    // 2000, and KLOC (4000 / 1000 = 4) ÷ cost ($2) = 2.
    expect(summary.mergedPrCount).toBe(2);
    expect(summary.medianPrSize).toBe(2000);
    expect(summary.mergedKlocPerDollar).toBe(2);
  });
  it("summarizes usage across multiple organization members", async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 3 },
      _sum: {
        inputTokens: 75,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        estimatedCost: 1.25,
      },
      _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
      _max: { sessionStartedAt: new Date("2026-03-14T10:00:00.000Z") },
    });
    const sessionGroupBy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          userId: "user-1",
          _count: { _all: 1 },
          _sum: {
            inputTokens: 25,
            outputTokens: 10,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            estimatedCost: 0.5,
          },
        },
        {
          userId: "user-2",
          _count: { _all: 2 },
          _sum: {
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            estimatedCost: 0.75,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          harness: "claude",
          _count: { _all: 3 },
          _sum: {
            inputTokens: 75,
            outputTokens: 30,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
            estimatedCost: 1.25,
          },
        },
      ])
      // Third call: repository facet groupBy (empty here).
      .mockResolvedValueOnce([])
      // Fourth call: cost split by sourceLoopId (empty here).
      .mockResolvedValueOnce([]);
    const computeTargetFindMany = vi.fn().mockResolvedValue([]);
    const sessionFindMany = vi.fn().mockResolvedValue([]);
    const artifactLinkFindFirst = vi.fn().mockResolvedValue(null);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate,
        groupBy: sessionGroupBy,
        findMany: sessionFindMany,
      }),
      artifactLink: {
        findFirst: artifactLinkFindFirst,
      },
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([
          {
            model: "claude-sonnet-4",
            _count: { _all: 3 },
            _sum: {
              inputTokens: 75,
              outputTokens: 30,
              cacheReadTokens: 5,
              cacheWriteTokens: 2,
              estimatedCost: 1.25,
            },
          },
        ]),
      },
      computeTarget: {
        findMany: computeTargetFindMany,
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
          {
            id: "user-2",
            email: "grace@example.com",
            firstName: "Grace",
            lastName: "Hopper",
            avatarUrl: null,
          },
        ]),
      },
    });

    await expect(
      agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual(
      expect.objectContaining({
        viewerScope: AgentSessionViewerScope.Organization,
        byUser: [
          expect.objectContaining({
            userId: "user-2",
            userName: "Grace Hopper",
            sessionCount: 2,
          }),
          expect.objectContaining({
            userId: "user-1",
            userName: "Ada Lovelace",
            sessionCount: 1,
          }),
        ],
      })
    );

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
    };
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    expect(sessionGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    // Cost split aggregates estimatedCost grouped by sourceLoopId and
    // billingMode in the DB rather than materializing one row per session.
    expect(sessionGroupBy).toHaveBeenCalledWith({
      by: ["sourceLoopId", "billingMode"],
      where: expectedWhere,
      _sum: {
        estimatedCost: true,
      },
    });
    // FEA-2923: buildLastSyncTargetWhere must exclude the synthetic per-org
    // "cloud" sentinel target so it is never counted as a synced device in the
    // usage/last-sync dashboard.
    expect(computeTargetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          isCloudSentinel: false,
        },
      })
    );
    expect(artifactLinkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: expect.objectContaining({
            session: { is: expectedWhere },
          }),
        }),
        select: { id: true },
      })
    );
    expect(sessionFindMany).not.toHaveBeenCalled();
  });
  it("excludes the cloud sentinel from the last-sync targets even with a userId filter (FEA-2923)", async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 0 },
      _sum: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
      },
      _min: { sessionStartedAt: null },
      _max: { sessionStartedAt: null },
    });
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const computeTargetFindMany = vi.fn().mockResolvedValue([]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate,
        groupBy,
        findMany: vi.fn().mockResolvedValue([]),
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: computeTargetFindMany },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: { userId: "user-1" },
    });

    // The sentinel exclusion lives on the base where, so it must survive
    // alongside the userId scope and never leak into the synced-device list.
    expect(computeTargetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          isCloudSentinel: false,
          userId: "user-1",
        },
      })
    );
  });
  it("splits attribution lenses by linked branches and trusted current PRs", async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 2 },
      _sum: {
        inputTokens: 390,
        outputTokens: 180,
        cacheReadTokens: 39,
        cacheWriteTokens: 18,
        estimatedCost: 3.9,
      },
      _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
      _max: { sessionStartedAt: new Date("2026-03-02T10:00:00.000Z") },
    });
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          userId: "user-1",
          _count: { _all: 2 },
          _sum: {
            inputTokens: 390,
            outputTokens: 180,
            cacheReadTokens: 39,
            cacheWriteTokens: 18,
            estimatedCost: 3.9,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const findMany = vi.fn().mockResolvedValue([
      buildAttributionLensRecord({
        artifactId: "session-1",
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 30,
        cacheWriteTokens: 15,
        estimatedCost: 3,
        branches: [
          trustedBranch("branch-1", "feature/a", 101),
          trustedBranch("branch-1", "feature/a", 999),
          staleBranch("branch-2", "feature/b", 102),
        ],
      }),
      buildAttributionLensRecord({
        artifactId: "session-2",
        inputTokens: 90,
        outputTokens: 30,
        cacheReadTokens: 9,
        cacheWriteTokens: 3,
        estimatedCost: 0.9,
        branches: [
          trustedBranch("branch-1", "feature/a", 101),
          referencedBranch("branch-3", "feature/c", 103),
          lowConfidenceBranch("branch-4", "feature/d", 104),
        ],
      }),
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate,
        groupBy,
        findMany,
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
        ]),
      },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    expect(summary.byUser).toEqual([
      expect.objectContaining({
        userId: "user-1",
        inputTokens: 390,
        estimatedCost: 3.9,
      }),
    ]);
    expect(summary.byBranch).toEqual([
      expect.objectContaining({
        branchArtifactId: "branch-1",
        sessionCount: 2,
        inputTokens: 180,
        estimatedCost: 1.8,
      }),
      expect.objectContaining({
        branchArtifactId: "branch-2",
        sessionCount: 1,
        inputTokens: 150,
        estimatedCost: 1.5,
      }),
      expect.objectContaining({
        branchArtifactId: "branch-3",
        sessionCount: 1,
        inputTokens: 30,
        estimatedCost: 0.3,
      }),
      expect.objectContaining({
        branchArtifactId: "branch-4",
        sessionCount: 1,
        inputTokens: 30,
        estimatedCost: 0.3,
      }),
    ]);
    expect(summary.byPr).toEqual([
      expect.objectContaining({
        repositoryFullName: "closedloop-ai/symphony-alpha",
        prNumber: 101,
        branchArtifactId: "branch-1",
        inputTokens: 180,
        estimatedCost: 1.8,
        purpose: SessionPrPurpose.Authored,
        purposeLabel: SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Authored],
      }),
      expect.objectContaining({
        prNumber: 103,
        estimatedCost: 0.3,
        purpose: SessionPrPurpose.Referenced,
        purposeLabel: SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Referenced],
      }),
      expect.objectContaining({
        prNumber: 104,
        estimatedCost: 0.3,
        purpose: SessionPrPurpose.Unknown,
        purposeLabel: SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Unknown],
      }),
    ]);
    expect(summary.byPr?.some((row) => row.prNumber === 102)).toBe(false);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { artifactId: "asc" },
        take: 200,
      })
    );
  });
  it("rounds non-divisible N=3 attribution shares per lens row", async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 1 },
      _sum: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCost: 1,
      },
      _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
      _max: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
    });
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          userId: "user-1",
          _count: { _all: 1 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            estimatedCost: 1,
          },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const findMany = vi.fn().mockResolvedValue([
      buildAttributionLensRecord({
        artifactId: "session-remainder",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCost: 1,
        branches: [
          trustedBranch("branch-1", "feature/a", 201),
          trustedBranch("branch-2", "feature/b", 202),
          trustedBranch("branch-3", "feature/c", 203),
        ],
      }),
    ]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate,
        groupBy,
        findMany,
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
      agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
      computeTarget: { findMany: vi.fn().mockResolvedValue([]) },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
        ]),
      },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    expect(summary.byUser).toEqual([
      expect.objectContaining({
        inputTokens: 100,
        estimatedCost: 1,
      }),
    ]);
    expect(summary.byBranch).toHaveLength(3);
    expect(summary.byBranch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchArtifactId: "branch-1",
          inputTokens: 33,
          outputTokens: 17,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          estimatedCost: 0.333_333,
        }),
        expect.objectContaining({
          branchArtifactId: "branch-2",
          inputTokens: 33,
          estimatedCost: 0.333_333,
        }),
        expect.objectContaining({
          branchArtifactId: "branch-3",
          inputTokens: 33,
          estimatedCost: 0.333_333,
        }),
      ])
    );
  });
  it("splits branch artifact session usage by distinct branch targets", async () => {
    const artifactFindFirst = vi.fn().mockResolvedValue({
      id: "branch-1",
      slug: "branch-one",
      branch: { artifactId: "branch-1" },
    });
    const artifactLinkFindMany = vi
      .fn()
      .mockResolvedValue([{ sourceId: "session-1" }]);
    const sessionFindMany = vi.fn().mockResolvedValue([
      buildAttributionLensRecord({
        artifactId: "session-1",
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        estimatedCost: 4,
        branches: [
          trustedBranch("branch-1", "feature/a", 101),
          referencedBranch("branch-2", "feature/b", 102),
        ],
      }),
    ]);
    const tokenUsageFindMany = vi.fn().mockResolvedValue([
      {
        agentSessionId: "session-1",
        model: "gpt-5.5",
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        estimatedCost: 4,
      },
    ]);

    installDb({
      artifact: { findFirst: artifactFindFirst },
      artifactLink: { findMany: artifactLinkFindMany },
      sessionDetail: buildAgentSessionDbMock({ findMany: sessionFindMany }),
      agentSessionTokenUsage: { findMany: tokenUsageFindMany },
    });

    await expect(
      agentSessionsService.getArtifactSessionUsage("org-1", "branch-1")
    ).resolves.toEqual({
      artifactId: "branch-1",
      artifactSlug: "branch-one",
      sessionCount: 1,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      estimatedCostUsd: 2,
      byModel: [
        {
          model: "gpt-5.5",
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          estimatedCostUsd: 2,
        },
      ],
    });
  });
  it("paginates analytics queries and counts tool coverage by session id", async () => {
    const scalarPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAnalyticsScalarRecord(index + 1)
    );
    const scalarPageTwo = [
      buildAnalyticsScalarRecord(201, {
        repositoryFullName: "closedloop-ai/closedloop-electron",
        inputTokens: 30,
        outputTokens: 15,
        estimatedCost: 0.75,
        errorCount: 2,
        artifact: {
          projectId: "project-2",
          project: {
            id: "project-2",
            name: "Desktop",
            slug: "desktop",
          },
        },
      }),
    ];
    const jsonPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAnalyticsJsonRecord(index + 1)
    );
    jsonPageOne[0] = buildAnalyticsJsonRecord(1, {
      agents: [
        buildPersistedAgent({
          type: "main",
          status: "completed",
          endedAt: "2026-05-20T17:01:00.000Z",
        }),
      ],
      events: [buildPersistedEvent()],
    });
    jsonPageOne[1] = buildAnalyticsJsonRecord(2, {
      agents: [
        buildPersistedAgent({
          externalAgentId: "agent-2",
          type: "worker",
          status: "failed",
          endedAt: "2026-05-20T17:02:00.000Z",
        }),
      ],
      events: [
        // "tool_failure" has no "error" substring: it counts as an error only
        // because aggregateByTool classifies via the shared ERROR_EVENT_PATTERN
        // (/error|fail/i), matching the desktop countErrorEvents. Under the old
        // `includes("error")` classifier this would have been errorCount: 0,
        // so this row guards the web/desktop drift fix.
        buildPersistedEvent({
          externalEventId: "event-2",
          eventType: "tool_failure",
        }),
      ],
    });
    const jsonPageTwo = [
      buildAnalyticsJsonRecord(201, {
        events: [
          buildPersistedEvent({
            externalEventId: "event-201",
            toolName: "Bash",
          }),
        ],
      }),
    ];
    const attributionPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAttributionLensRecord({
        artifactId: `session-${index + 1}`,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        branches: [],
      })
    );
    const attributionPageTwo = [
      buildAttributionLensRecord({
        artifactId: "session-201",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        branches: [],
      }),
    ];

    const findMany = vi
      .fn()
      .mockResolvedValueOnce(scalarPageOne)
      .mockResolvedValueOnce(scalarPageTwo)
      .mockResolvedValueOnce(jsonPageOne)
      .mockResolvedValueOnce(jsonPageTwo)
      .mockResolvedValueOnce(attributionPageOne)
      .mockResolvedValueOnce(attributionPageTwo);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
    });

    await expect(
      agentSessionsService.getAnalytics({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      viewerScope: AgentSessionViewerScope.Organization,
      byTool: [
        {
          toolName: "Read",
          invocationCount: 2,
          errorCount: 1,
          sessionCount: 2,
        },
        {
          toolName: "Bash",
          invocationCount: 1,
          errorCount: 0,
          sessionCount: 1,
        },
      ],
      byAgentType: [
        {
          agentType: "main",
          count: 1,
          successCount: 1,
          failedCount: 0,
          avgDurationMs: 60_000,
        },
        {
          agentType: "worker",
          count: 1,
          successCount: 0,
          failedCount: 1,
          avgDurationMs: 120_000,
        },
      ],
      byRepository: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
          errorCount: 0,
        },
        {
          repositoryFullName: "closedloop-ai/closedloop-electron",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
          errorCount: 2,
        },
      ],
      byProject: [
        {
          projectId: "project-1",
          projectName: "Agent Platform",
          projectSlug: "agent-platform",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
        },
        {
          projectId: "project-2",
          projectName: "Desktop",
          projectSlug: "desktop",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
        },
      ],
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
    expect(findMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
    expect(findMany).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
  });
});
