import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  type BranchPageDetail,
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { exactCohortMetricParityExpectation } from "@repo/lib/branches/__tests__/exact-cohort-metric-parity-fixture";
import { describe, expect, it } from "vitest";
import {
  attachCanonicalDetailMetrics,
  type CloudCanonicalMetricRow,
  projectCloudCanonicalLastActive,
  projectCloudCanonicalMetrics,
} from "./branch-canonical-metric-projection";

describe("cloud canonical Branch metric projection", () => {
  it("uses every persisted associated PR and the non-date cohort", () => {
    const metrics = projectCloudCanonicalMetrics(
      [
        cloudRow("merged", "2026-08-01T00:00:00.000Z", 1),
        {
          ...cloudRow("current", "2026-08-02T00:00:00.000Z", 2),
          pullRequestDetails: [],
        },
      ],
      {
        startDate: new Date("2026-07-27T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
      },
      new Date("2026-08-03T00:00:00.000Z")
    );

    expect(metrics.cohortSize).toBe(2);
    expect(metrics.activeBranches.current.value).toBe(1);
    expect(metrics.medianPrSize.current.value).toBe(12);
    expect(metrics.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("ignores a polluted compatibility aggregate and later PR projection", () => {
    const row = cloudRow("canonical", "2026-08-01T00:00:00.000Z", 1);
    Object.assign(row.branch, {
      lastActivityAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const pullRequest = row.pullRequestDetails[0];
    if (!pullRequest) {
      throw new Error("Expected a pull request fixture");
    }
    pullRequest.mergedAt = new Date("2026-08-02T00:00:00.000Z");

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
    expect(
      projectCloudCanonicalMetrics(
        [row],
        {},
        new Date("2026-08-03T00:00:00.000Z")
      ).lastActiveAt
    ).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reports Last active unavailable when no immutable atom exists", () => {
    const row = cloudRow("unavailable", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [];
    Object.assign(row.branch, {
      lastActivityAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(projectCloudCanonicalLastActive(row)).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    expect(
      projectCloudCanonicalMetrics(
        [row],
        {},
        new Date("2026-08-03T00:00:00.000Z")
      ).lastActiveAt
    ).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("skips malformed newer atoms and retains an older eligible atom", () => {
    const row = cloudRow("eligible", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [
      {
        version: BranchActivityAtomVersion.V1 + 1,
        source: "future_source",
        sourceEventId: "future-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        attributionKind: BranchActivityAttributionKind.Branch,
        pullRequestDetailId: null,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      ...row.branch.activityAtoms,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it.each([
    {
      label: "unknown source",
      override: { source: "future_source" },
    },
    {
      label: "empty event identity",
      override: { sourceEventId: "" },
    },
    {
      label: "invalid completeness",
      override: {
        completeness: BranchActivityEvidenceCompleteness.Unavailable,
      },
    },
    {
      label: "invalid attribution",
      override: { attributionKind: "future_attribution" },
    },
    {
      label: "branch attribution carrying a PR id",
      override: { pullRequestDetailId: "foreign-pr" },
    },
  ])("skips a newer atom with $label", ({ override }) => {
    const row = cloudRow("validation", "2026-08-01T00:00:00.000Z", 1);
    const eligible = row.branch.activityAtoms[0];
    if (!eligible) {
      throw new Error("Expected an eligible activity fixture");
    }
    row.branch.activityAtoms = [
      {
        ...eligible,
        sourceEventId: "newer-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        ...override,
      },
      eligible,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("rejects PR attribution that does not belong to the same Branch", () => {
    const row = cloudRow("attribution", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [
      {
        version: BranchActivityAtomVersion.V1,
        source: BranchActivitySource.PullRequestLifecycle,
        sourceEventId: "foreign-pr-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        attributionKind: BranchActivityAttributionKind.PullRequest,
        pullRequestDetailId: "foreign-pr",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      ...row.branch.activityAtoms,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("uses event time, canonical phase, and the global Branch divisor", () => {
    const row = cloudRow("shared", "2026-08-01T00:00:00.000Z", 1);
    const metrics = projectCloudCanonicalMetrics(
      [row],
      {
        startDate: new Date("2026-07-27T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
      },
      new Date("2026-08-03T00:00:00.000Z"),
      new Map([
        [
          row.id,
          {
            sessionIds: ["session-1"],
            sessions: [
              {
                sessionId: "session-1",
                slug: null,
                name: null,
                harness: "codex",
                startedAt: "2026-08-01T00:00:00.000Z",
                endedAt: "2026-08-01T00:01:00.000Z",
                isPrimary: false,
                participation: BranchParticipationKind.Wrote,
                branchCount: 2,
                estimatedCostUsd: 10,
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                ownerUserName: null,
                activitySegments: [
                  {
                    phase: "implement",
                    startMs: Date.parse("2026-08-01T00:00:00.000Z"),
                    endMs: Date.parse("2026-08-01T00:01:00.000Z"),
                    costUsd: 10,
                    inputTokens: 1,
                    outputTokens: 1,
                    confidence: 1,
                    sourceEventIds: ["event-1"],
                    costEvents: [
                      {
                        sourceEventId: "event-1",
                        occurredAtMs: Date.parse("2026-08-01T00:00:30.000Z"),
                        costUsd: 10,
                      },
                    ],
                  },
                ],
              },
            ],
            ownerCounts: new Map(),
            sessionOwnerById: new Map(),
            sessionBillingModeById: new Map(),
            lifecycleEventsBySession: new Map([
              [
                "session-1",
                [
                  {
                    kind: BranchLifecycleBoundaryKind.BranchWrite,
                    observedAt: "2026-08-01T00:00:30.000Z",
                    evidenceId: "push-1",
                    method: "git_push",
                  },
                ],
              ],
            ]),
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCostUsd: 10,
          },
        ],
      ])
    );

    expect(metrics.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 5,
    });
  });

  it("matches the exact-cohort cross-surface metric fixture", () => {
    const row = cloudRow("shared", "2026-08-01T00:00:00.000Z", 1);
    const metrics = projectCloudCanonicalMetrics(
      [row],
      {
        startDate: new Date("2026-07-27T00:00:00.000Z"),
        endDate: new Date("2026-08-03T00:00:00.000Z"),
      },
      new Date("2026-08-03T00:00:00.000Z"),
      cloudUsageByBranch(row.id)
    );

    expect(metricParitySubset(metrics)).toEqual(
      exactCohortMetricParityExpectation
    );
  });

  it("uses persisted lifetime LOC for an all-time exact cohort", () => {
    const row = cloudRow("lifetime", "2026-08-01T00:00:00.000Z", 1);

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      new Date("2026-08-03T00:00:00.000Z"),
      cloudUsageByBranch(row.id)
    );

    expect(metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1.2,
    });
  });

  it("fails closed when the persisted file cache reaches its truncation cap", () => {
    const row = cloudRow("truncated", "2026-08-01T00:00:00.000Z", 1);
    row.branch.fileCacheFileCount = 500;
    row.branch.fileChanges = Array.from({ length: 500 }, () => ({
      additions: 1,
      deletions: 0,
    }));

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      new Date("2026-08-03T00:00:00.000Z"),
      cloudUsageByBranch(row.id)
    );

    expect(metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("uses selected-PR LOC instead of Branch file-cache LOC for detail", () => {
    const detail: Pick<
      BranchPageDetail,
      "associatedPullRequests" | "canonicalMetrics"
    > & { additions: number; deletions: number } = {
      additions: 1000,
      deletions: 1000,
      associatedPullRequests: {
        items: [
          {
            id: "org/repo#1",
            repositoryFullName: "org/repo",
            number: 1,
            title: null,
            url: null,
            state: GitHubPRState.Merged,
            isDraft: false,
            reviewDecision: null,
            openedAt: "2026-07-30T00:00:00.000Z",
            closedAt: "2026-08-01T00:00:00.000Z",
            mergedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        selectedId: "org/repo#1",
        selectionReason:
          BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
        },
      },
    };

    attachCanonicalDetailMetrics(
      detail,
      {
        segments: [],
        rollups: [
          {
            phase: BranchVisibleLifecyclePhase.Build,
            estimatedCostUsd: 20,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 0,
            sessionCount: 1,
          },
        ],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 20,
        },
      },
      { additions: 50, deletions: 50 }
    );

    expect(detail.canonicalMetrics?.locPerDollar.value).toBe(5);
  });
});

function cloudRow(
  id: string,
  activityAt: string,
  number: number
): CloudCanonicalMetricRow {
  return {
    id,
    status: BranchStatus.Open,
    branch: {
      repositoryId: "repo-id",
      repositoryFullName: "org/repo",
      repository: { fullName: "org/repo" },
      activityAtoms: [
        {
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.GitHead,
          sourceEventId: `head:${id}`,
          occurredAt: new Date(activityAt),
          attributionKind: BranchActivityAttributionKind.Branch,
          pullRequestDetailId: null,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
      headSha: "head-sha",
      fileCacheStatus: BranchFileCacheStatus.Fresh,
      fileCacheHeadSha: "head-sha",
      fileCacheFileCount: 1,
      fileChanges: [{ additions: 10, deletions: 2 }],
    },
    pullRequestDetails: [
      {
        id: `pr-${id}`,
        branchArtifactId: id,
        repositoryId: "repo-id",
        repositoryFullName: "org/repo",
        repository: { fullName: "org/repo" },
        number,
        title: null,
        htmlUrl: null,
        prState: GitHubPRState.Merged,
        isDraft: false,
        reviewDecision: null,
        githubCreatedAt: new Date("2026-07-30T00:00:00.000Z"),
        closedAt: new Date("2026-08-01T00:00:00.000Z"),
        mergedAt: new Date("2026-08-01T00:00:00.000Z"),
        lastVerifiedAt: new Date("2026-08-01T01:00:00.000Z"),
        additions: 10,
        deletions: 2,
      },
    ],
  };
}

function cloudSessionUsage() {
  return {
    sessionId: "session-1",
    slug: null,
    name: null,
    harness: "codex",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    isPrimary: false,
    participation: BranchParticipationKind.Wrote,
    branchCount: 1,
    estimatedCostUsd: 10,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserName: null,
    activitySegments: [
      {
        phase: "implement",
        startMs: Date.parse("2026-08-01T00:00:00.000Z"),
        endMs: Date.parse("2026-08-01T00:01:00.000Z"),
        costUsd: 10,
        inputTokens: 1,
        outputTokens: 1,
        confidence: 1,
        sourceEventIds: ["event-1"],
        costEvents: [
          {
            sourceEventId: "event-1",
            occurredAtMs: Date.parse("2026-08-01T00:00:30.000Z"),
            costUsd: 10,
          },
        ],
      },
    ],
  };
}

function cloudUsageByBranch(branchId: string) {
  return new Map([
    [
      branchId,
      {
        sessionIds: ["session-1"],
        sessions: [cloudSessionUsage()],
        ownerCounts: new Map(),
        sessionOwnerById: new Map(),
        sessionBillingModeById: new Map(),
        lifecycleEventsBySession: new Map([
          [
            "session-1",
            [
              {
                kind: BranchLifecycleBoundaryKind.BranchWrite,
                observedAt: "2026-08-01T00:00:30.000Z",
                evidenceId: "push-1",
                method: "git_push",
              },
            ],
          ],
        ]),
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 10,
      },
    ],
  ]);
}

function metricParitySubset(
  metrics: ReturnType<typeof projectCloudCanonicalMetrics>
) {
  return {
    cohortSize: metrics.cohortSize,
    medianPrSize: metrics.medianPrSize.current,
    aiSpendUsd: metrics.aiSpendUsd.current,
    mergeRatePct: metrics.mergeRatePct.current,
    activeComparisonState: metrics.activeBranches.comparison?.deltaPct.state,
    locPerDollarState: metrics.locPerDollar.current.state,
  };
}
