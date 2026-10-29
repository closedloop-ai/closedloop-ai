import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  SESSION_PR_PURPOSE_LABELS,
  SessionArtifactLinkKind,
  SessionPrPurpose,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributionReadMocks,
  buildAgentSessionDbMock,
  buildAttributionLensRecord,
  installDb,
  lowConfidenceBranch,
  referencedBranch,
  staleBranch,
  trustedBranch,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { usageOwnerGroupMocks } from "@/__tests__/support/agent-sessions/usage-owner-groups.test-mocks";
import { agentSessionsService } from "../service";
import { SessionCostLedger } from "./usage-cost-split";

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

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("splits usage summary costs by stored ledger, then billingMode", async () => {
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
          /* Third sessionDetail.groupBy call: cost split grouped by
             legacyLoopCostLedger and billingMode. Former loop rows keep the
             ledger stored on the session (ISS-12435); DESKTOP_SYNC rows (null
             ledger) are classified by their synced billingMode: a
             subscription/seat mode counts toward subscription cost, anything
             else toward API cost.
             Binary-exact values so the subscription/API sums compare equal under
             toEqual without floating-point drift. */
          .mockResolvedValueOnce([
            {
              legacyLoopCostLedger: SessionCostLedger.Subscription,
              billingMode: null,
              _sum: { estimatedCost: 0.5 },
            },
            {
              legacyLoopCostLedger: SessionCostLedger.Metered,
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
            // DESKTOP_SYNC, subscription/seat billingMode → subscription cost.
            {
              legacyLoopCostLedger: null,
              billingMode: "pro",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, API billingMode → API cost.
            {
              legacyLoopCostLedger: null,
              billingMode: "api",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, legacy null billingMode → API cost.
            {
              legacyLoopCostLedger: null,
              billingMode: null,
              _sum: { estimatedCost: 0.125 },
            },
            {
              legacyLoopCostLedger: SessionCostLedger.Unknown,
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
          ])
          // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
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
    });

    await expect(
      agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual(
      expect.objectContaining({
        // FEA-3986: the grand total is derived FROM the classified buckets
        // (subscription + API), NOT from the separate `aggregate` query — which
        // this fixture deliberately seeds at a DIVERGENT 1.5 to model a
        // non-transactional drift between the two reads. The old two-read code
        // published that stale 1.5 headline against a 0.625 + 0.75 = 1.375
        // breakdown; deriving from the one bucket snapshot yields 1.375, so the
        // headline and breakdown can no longer disagree.
        totalEstimatedCost: 1.375,
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

  it("keeps totalEstimatedCost === subscription + api even when the aggregate total drifts", async () => {
    // FEA-3986 invariant guard. The `aggregate` query is seeded at 9.99 — a value
    // that AGREES with NEITHER bucket sum — modelling a non-transactional drift
    // between the grand-total read and the split read. The old code published the
    // aggregate as `totalEstimatedCost` and this assertion would fail (9.99 !==
    // 0.625 + 0.75). Deriving the total from the one bucket snapshot makes the
    // headline the sum of the split BY CONSTRUCTION, so the invariant holds.
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 4 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            // Deliberately divergent from the classified buckets below.
            estimatedCost: 9.99,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-14T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          // byHarness
          .mockResolvedValueOnce([])
          // byRepository
          .mockResolvedValueOnce([])
          // cost split by legacyLoopCostLedger + billingMode
          .mockResolvedValueOnce([
            {
              legacyLoopCostLedger: SessionCostLedger.Subscription,
              billingMode: null,
              _sum: { estimatedCost: 0.625 },
            },
            {
              legacyLoopCostLedger: SessionCostLedger.Metered,
              billingMode: null,
              _sum: { estimatedCost: 0.75 },
            },
          ])
          // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
          // Unused by this test's assertions; empty snapshot.
          .mockResolvedValueOnce([]),
      }),
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([]),
      },
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const summary = await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    expect(summary.subscriptionEstimatedCost).toBe(0.625);
    expect(summary.apiEstimatedCost).toBe(0.75);
    // The load-bearing invariant: total is the sum of the split, NOT the drifted
    // aggregate (9.99).
    expect(summary.totalEstimatedCost).toBe(
      summary.subscriptionEstimatedCost + summary.apiEstimatedCost
    );
    expect(summary.totalEstimatedCost).toBe(1.375);
  });

  it("summarizes usage across multiple organization members", async () => {
    const owners = usageOwnerGroupMocks(
      () => ({
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
      }),
      [
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
      ]
    );
    const aggregate = owners.aggregate;
    const sessionGroupBy = vi
      .fn()
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
      // Second call: repository facet groupBy (empty here).
      .mockResolvedValueOnce([])
      // Third call: headline cost split by ledger (empty here).
      .mockResolvedValueOnce([])
      // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
      // Unused by this test's assertions; empty snapshot.
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
      artifact: { groupBy: owners.artifactGroupBy },
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
        // FEA-3345: hiding idle rows is now opt-in via an explicit `substantive`
        // (the fail-open default is `all`). Pass it so this test exercises the
        // substantive aggregation predicate below.
        filters: { quality: "substantive" },
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

    // FEA-3284/FEA-3345: on an explicit `quality:"substantive"`, the usage/summary
    // aggregations apply the SAME substantive predicate as the list, so headline
    // counts/tokens never include idle "phantom" rows or diverge from the list.
    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      AND: [
        {
          OR: [
            { turns: { gt: 0 } },
            { inputTokens: { gt: 0 } },
            { outputTokens: { gt: 0 } },
            { cacheReadTokens: { gt: 0 } },
            { cacheWriteTokens: { gt: 0 } },
            { toolUseCount: { gt: 0 } },
            // ISS-5801: the substantive inventory gained the invocation arm.
            { componentInvocationCount: { gt: 0 } },
          ],
        },
      ],
    };
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    expect(sessionGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    // Cost split aggregates estimatedCost grouped by legacyLoopCostLedger and
    // billingMode in the DB rather than materializing one row per session.
    expect(sessionGroupBy).toHaveBeenCalledWith({
      by: ["legacyLoopCostLedger", "billingMode"],
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
    const probeCall = artifactLinkFindFirst.mock.calls[0]?.[0];
    expect(probeCall).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          source: expect.objectContaining({
            session: { is: expectedWhere },
          }),
          OR: expect.arrayContaining([
            expect.objectContaining({
              AND: expect.arrayContaining([
                expect.objectContaining({
                  OR: expect.arrayContaining([
                    expect.objectContaining({
                      metadata: {
                        path: ["linkKind"],
                        equals: SessionArtifactLinkKind.SessionBranch,
                      },
                    }),
                  ]),
                }),
              ]),
            }),
          ]),
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
      // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
      // Unused by this test's assertions; empty snapshot.
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
      // Unused by this test's assertions; empty snapshot.
      .mockResolvedValueOnce([]);
    const attribution = attributionReadMocks([
      buildAttributionLensRecord({
        artifactId: "session-1",
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 30,
        cacheWriteTokens: 15,
        estimatedCost: 3,
        branches: [
          trustedBranch("branch-1", "feature/a", 101),
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
        findMany: attribution.sessionDetailFindMany,
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
        findMany: attribution.artifactLinkFindMany,
      },
      artifact: {
        findMany: attribution.artifactFindMany,
        // ISS-12251: the one Owner; the per-assignee aggregate answers with the
        // totals above, which are hers.
        groupBy: vi.fn().mockResolvedValue([{ assigneeId: "user-1" }]),
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
        repositoryFullName: "closedloop-ai/closedloop-ai",
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
    // ISS-7655: the lenses come from a set-based read now, so the paged
    // `orderBy artifactId asc / take 200` shape this used to pin is gone. What
    // still needs pinning is that these rows came from the attribution read and
    // not from another reader's mock.
    expect(attribution.artifactLinkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ metadata: true }),
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // Fourth call (FEA-4303): the primary-model facet groupBy (by `model`).
      // Unused by this test's assertions; empty snapshot.
      .mockResolvedValueOnce([]);
    const attribution = attributionReadMocks([
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
        findMany: attribution.sessionDetailFindMany,
      }),
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "link-1" }),
        findMany: attribution.artifactLinkFindMany,
      },
      artifact: {
        findMany: attribution.artifactFindMany,
        groupBy: vi.fn().mockResolvedValue([{ assigneeId: "user-1" }]),
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
    const attribution = attributionReadMocks(
      [
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
      ],
      [{ sourceId: "session-1" }]
    );
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
      artifact: {
        findFirst: artifactFindFirst,
        findMany: attribution.artifactFindMany,
      },
      artifactLink: { findMany: attribution.artifactLinkFindMany },
      sessionDetail: buildAgentSessionDbMock({
        findMany: attribution.sessionDetailFindMany,
      }),
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
});
