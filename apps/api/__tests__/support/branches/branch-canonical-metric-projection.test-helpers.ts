import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import { sessionPrIdentityKey } from "@repo/api/src/types/session-artifact-link";
import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import { resolveCanonicalBranchMetricWindows } from "@repo/lib/branches/branch-list-metric-projection";
import {
  type BranchMetricPullRequestFacts,
  type BranchMetricPullRequestWindowFacts,
  branchMetricFactWindows,
  branchMetricWindowKey,
} from "@repo/lib/branches/branch-pull-request-metrics";
import { toBranchFileChangeTotals } from "@/__tests__/support/branches/branch-file-change-totals.test-helpers";
import type {
  CloudCanonicalMetricRow,
  projectCloudCanonicalMetrics,
} from "@/app/branches/branch-canonical-metric-projection";
import { withBranchPushLocEvidence } from "@/app/branches/branch-push-loc-read";
import type { OrgMergedPullRequestAdmissionMap } from "@/lib/pull-request-population";

export function cloudRow(
  id: string,
  activityAt: string,
  number: number
): CloudCanonicalMetricRow {
  return {
    id,
    status: BranchStatus.Open,
    _count: { pullRequestDetails: 1 },
    branch: {
      repositoryId: "repo-id",
      repositoryFullName: "org/repo",
      repository: { fullName: "org/repo" },
      branchName: "feat/test",
      firstPushedAt: new Date(activityAt),
      pushSource: "webhook",
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
      headSha: "a".repeat(40),
      headShaSource: "push_webhook",
      headShaObservedAt: new Date(activityAt),
      fileCacheStatus: BranchFileCacheStatus.Fresh,
      fileCacheHeadSha: "a".repeat(40),
      fileCacheCapped: false,
      fileCacheFileCount: 1,
      fileChangeTotals: toBranchFileChangeTotals(
        [{ additions: 10, deletions: 2 }],
        "a".repeat(40)
      ),
    },
    pullRequestDetails: [
      {
        id: `pr-${id}`,
        branchArtifactId: id,
        repositoryId: "repo-id",
        repositoryFullName: "org/repo",
        repository: { fullName: "org/repo" },
        githubId: `PR_node_${number}`,
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
        changedFiles: 1,
        headRefOid: "a".repeat(40),
        headRefName: "feat/test",
        headRepositoryFullName: "org/repo",
      },
    ],
  };
}

export function cloudSessionUsage(branchCount: number | null = 1) {
  return {
    sessionId: "session-1",
    slug: null,
    name: null,
    harness: "codex",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    isPrimary: false,
    participation: BranchParticipationKind.Wrote,
    ...(branchCount === null ? {} : { branchCount }),
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

export function cloudUsageByBranch(
  branchId: string,
  branchCount: number | null = 1
) {
  return new Map([
    [
      branchId,
      {
        sessionIds: ["session-1"],
        sessions: [cloudSessionUsage(branchCount)],
        sessionOwnerById: new Map(),
        sessionBillingModeById: new Map(),
        sessionDisplayInputsById: new Map(),
        sessionOwnerProfileById: new Map(),
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
        hasPricedCost: true,
      },
    ],
  ]);
}

export function orgMergedAdmissionForRows(
  ...rows: readonly CloudCanonicalMetricRow[]
): OrgMergedPullRequestAdmissionMap {
  return new Map(
    rows.flatMap((row) =>
      row.pullRequestDetails.length === 0
        ? []
        : [[row.id, orgMergedAdmissionForPullRequestDetails(row)]]
    )
  );
}

export function orgMergedAdmissionForPullRequests(
  row: CloudCanonicalMetricRow,
  pullRequests: readonly CloudCanonicalMetricRow["pullRequestDetails"][number][]
): OrgMergedPullRequestAdmissionMap {
  return new Map([
    [row.id, orgMergedAdmissionForPullRequestDetails(row, pullRequests)],
  ]);
}

export function orgMergedAdmissionForPullRequestDetails(
  row: CloudCanonicalMetricRow,
  pullRequests: readonly CloudCanonicalMetricRow["pullRequestDetails"][number][] = row.pullRequestDetails
) {
  return {
    exactIdentities: new Set(
      pullRequests.map((pullRequest) =>
        sessionPrIdentityKey(
          pullRequest.repository?.fullName ?? pullRequest.repositoryFullName,
          pullRequest.number
        )
      )
    ),
    legacyUniqueFallback: false,
    tierTwoUniqueBranchFallback: false,
    branchEvidence: false,
    pullRequestCount: row._count.pullRequestDetails,
  };
}

export function metricParitySubset(
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

/** The facts the SQL fold would publish, the same for every window the fold asks about. */
export function pullRequestFactsFor(
  query: { startDate?: Date; endDate?: Date },
  now: Date,
  counts: BranchMetricPullRequestWindowFacts
): BranchMetricPullRequestFacts {
  const windows = branchMetricFactWindows(
    resolveCanonicalBranchMetricWindows({ ...query, now })
  );
  return {
    conflicted: false,
    windows: new Map(
      windows.map((window) => [branchMetricWindowKey(window), counts])
    ),
  };
}

/** The cost facts the SQL fold would publish, the same for every window the fold asks about. */
export function costFactsFor(
  query: { startDate?: Date; endDate?: Date },
  now: Date,
  window: { spendUsd: number; included: number; unusable: number }
): BranchMetricCostFacts {
  const windows = branchMetricFactWindows(
    resolveCanonicalBranchMetricWindows({ ...query, now })
  );
  return {
    cohortHoldsEvents: true,
    windows: new Map(
      windows.map((entry) => [branchMetricWindowKey(entry), window])
    ),
  };
}

/**
 * The row with one captured push whose head is the row's merged PR head, so the
 * push lane covers the merged PR and the row carries pushed LOC.
 */
export function withCapturedPush(
  row: CloudCanonicalMetricRow,
  lines: { additions: number; deletions: number }
) {
  const pushedAt = row.branch.firstPushedAt ?? new Date(0);
  const [pushed] = withBranchPushLocEvidence([row], {
    byBranchId: new Map([
      [
        row.id,
        [
          {
            branchArtifactId: row.id,
            sourceEventId: `push-${row.id}`,
            occurredAt: pushedAt,
            createdAt: pushedAt,
            beforeSha: "0".repeat(40),
            afterSha: "a".repeat(40),
            linesAdded: lines.additions,
            linesRemoved: lines.deletions,
          },
        ],
      ],
    ]),
    unusableByBranchId: new Map(),
    truncatedBranchIds: new Set(),
  });
  if (!pushed) {
    throw new Error("Expected the pushed row");
  }
  return pushed;
}
