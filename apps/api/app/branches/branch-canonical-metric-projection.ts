import { BranchFileCacheStatus } from "@repo/api/src/types/artifact";
import {
  type BranchPageDetail,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import { BranchAssociatedPullRequestCompletenessState } from "@repo/api/src/types/branch-associated-pull-request";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import type {
  BranchPhaseAttributionCompletenessReason,
  BranchPhaseAttributionResult,
} from "@repo/api/src/types/branch-phase-attribution";
import { BranchPhaseAttributionCompleteness } from "@repo/api/src/types/branch-phase-attribution";
import {
  branchMetricCycleFromPullRequest,
  calculateBranchDetailMetrics,
  selectedCycleSuccessfulPushAt,
} from "@repo/lib/branches/branch-detail-outcomes";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import { calculateBranchLastActiveMetric } from "@repo/lib/branches/branch-list-metrics";
import {
  type CanonicalCloudBranchActivityAtom,
  latestEligibleCloudBranchActivityAtom,
} from "./branch-activity-canonical-read";
import {
  type CloudBranchProjectionInput,
  type CloudPullRequestProjectionInput,
  projectCloudBranchAssociatedPullRequests,
  statusForSelectedCloudPullRequest,
} from "./branch-associated-pull-request-projection";
import { buildBranchPhaseAttribution } from "./branch-lifecycle-phase-rollup";
import { currentFileTotals } from "./branch-loc";
import type { SessionUsage } from "./branch-read-service/session-usage-window";

type CloudMetricPullRequest = CloudPullRequestProjectionInput & {
  id: string;
  additions: number | null;
  deletions: number | null;
};

const BRANCH_ANALYTICS_FILE_CACHE_ROW_LIMIT = 500;

export type CloudCanonicalMetricRow =
  CloudBranchProjectionInput<CloudMetricPullRequest> & {
    status: string;
    branch: NonNullable<
      CloudBranchProjectionInput<CloudMetricPullRequest>["branch"]
    > & {
      activityAtoms: readonly CanonicalCloudBranchActivityAtom[];
      headSha: string | null;
      fileCacheStatus: string;
      fileCacheHeadSha: string | null;
      fileCacheFileCount: number;
      fileChanges: readonly {
        additions: number | null;
        deletions: number | null;
      }[];
    };
  };

/** Project one cloud row's Last active from its latest immutable activity atom. */
export function projectCloudCanonicalLastActive(
  row: CloudCanonicalActivityRow
) {
  const event = canonicalCloudActivityEvent(row);
  return calculateBranchLastActiveMetric(event ? [event] : [], false);
}

/** Build the cloud list bundle from the full non-date-filtered cohort. */
export function projectCloudCanonicalMetrics(
  rows: readonly CloudCanonicalMetricRow[],
  query: { startDate?: Date; endDate?: Date },
  requestBoundary: Date,
  lifetimeUsageByBranch: ReadonlyMap<string, SessionUsage> = new Map(),
  phaseCoverageReasons: readonly BranchPhaseAttributionCompletenessReason[] = []
) {
  const projections = rows.map((row) => ({
    row,
    associated: projectCloudBranchAssociatedPullRequests(row),
    activity: canonicalCloudActivityEvent(row),
  }));
  const phaseByBranch = new Map(
    projections.flatMap(({ row, associated }) => {
      const usage = lifetimeUsageByBranch.get(row.id);
      if (!usage) {
        return [];
      }
      return [
        [
          row.id,
          buildBranchPhaseAttribution({
            sessions: usage.sessions,
            lifecycleEventsBySession:
              usage.lifecycleEventsBySession ?? new Map(),
            associatedPullRequests: associated.collection,
            coverageReasons: phaseCoverageReasons,
          }),
        ] as const,
      ];
    })
  );
  const locEvidence = cloudLocEvidence(rows, query);
  const metrics = projectCanonicalBranchListMetrics({
    branches: projections.map(({ row, associated, activity }) => ({
      id: row.id,
      status: statusForSelectedCloudPullRequest(
        row.status,
        associated.selected?.source ?? null
      ),
      lastActivityAt: activity?.occurredAt ?? null,
    })),
    pullRequests: projections.flatMap(({ row, associated }) =>
      associated.collection.items.map((pullRequest) => {
        const source = sourcePullRequest(row, pullRequest.id);
        return {
          identity: pullRequest.id,
          mergedAt: pullRequest.mergedAt,
          closedAt: pullRequest.closedAt,
          isDraft: pullRequest.isDraft === true,
          additions: source?.additions ?? null,
          deletions: source?.deletions ?? null,
        };
      })
    ),
    pullRequestCoverageComplete: projections.every(
      ({ associated }) =>
        associated.collection.completeness.state ===
        BranchAssociatedPullRequestCompletenessState.Complete
    ),
    lastActiveEvents: projections.flatMap(({ activity }) =>
      activity ? [activity] : []
    ),
    // A latest-only projection cannot claim complete historical coverage.
    lastActiveCoverageComplete: false,
    locContributions: locEvidence.contributions,
    locCompleteBranchIds: locEvidence.completeBranchIds,
    costContributions: [...phaseByBranch].flatMap(([branchId, attribution]) =>
      attribution.segments.flatMap((segment) =>
        (segment.costEvents ?? []).map((event) => ({
          sourceEventId: event.sourceEventId,
          branchId,
          sessionId: segment.sessionId,
          occurredAt: new Date(event.occurredAtMs).toISOString(),
          phase: segment.phase,
          costUsd: event.costUsd,
          qualifyingBranchCount: segment.qualifyingBranchCount ?? null,
        }))
      )
    ),
    costCompleteBranchIds: [...phaseByBranch].flatMap(
      ([branchId, attribution]) =>
        attribution.coverage.completeness ===
          BranchPhaseAttributionCompleteness.Complete &&
        hasCompleteEventLevelCost(attribution)
          ? [branchId]
          : []
    ),
    startDate: query.startDate,
    endDate: query.endDate,
    now: requestBoundary,
  });
  if (
    metrics.locPerDollar.current.state ===
      BranchMetricAvailability.NotApplicable &&
    hasPositiveCompleteCostForIncompleteLoc(
      locEvidence.incompleteBranchIds,
      phaseByBranch
    )
  ) {
    metrics.locPerDollar.current = {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    };
  }
  return metrics;
}

type CloudCanonicalActivityRow = {
  id: string;
  pullRequestDetails: readonly { id: string; branchArtifactId: string }[];
  branch: { activityAtoms: readonly CanonicalCloudBranchActivityAtom[] };
};

function canonicalCloudActivityEvent(row: CloudCanonicalActivityRow):
  | {
      sourceEventId: string;
      occurredAt: string;
    }
  | undefined {
  const atom = latestEligibleCloudBranchActivityAtom(row);
  if (!atom) {
    return;
  }
  return {
    sourceEventId: `branch:${row.id}:${atom.source}:${atom.sourceEventId}`,
    occurredAt: atom.occurredAt.toISOString(),
  };
}

function cloudLocEvidence(
  rows: readonly CloudCanonicalMetricRow[],
  query: { startDate?: Date; endDate?: Date }
): {
  contributions: Array<{
    sourceEventId: string;
    branchId: string;
    occurredAt: null;
    additions: number;
    deletions: number;
  }>;
  completeBranchIds: string[];
  incompleteBranchIds: string[];
} {
  if (query.startDate || query.endDate) {
    return {
      contributions: [],
      completeBranchIds: [],
      incompleteBranchIds: rows.map((row) => row.id),
    };
  }
  const contributions: Array<{
    sourceEventId: string;
    branchId: string;
    occurredAt: null;
    additions: number;
    deletions: number;
  }> = [];
  const completeBranchIds: string[] = [];
  const incompleteBranchIds: string[] = [];
  for (const row of rows) {
    if (!hasCompleteCloudLocCache(row)) {
      incompleteBranchIds.push(row.id);
      continue;
    }
    const totals = currentFileTotals(
      row.branch.fileChanges,
      row.branch.fileCacheHeadSha,
      row.branch.headSha
    );
    if (totals.additions === null || totals.deletions === null) {
      incompleteBranchIds.push(row.id);
      continue;
    }
    contributions.push({
      sourceEventId: `branch-file-cache:${row.id}:${row.branch.headSha}`,
      branchId: row.id,
      occurredAt: null,
      additions: totals.additions,
      deletions: totals.deletions,
    });
    completeBranchIds.push(row.id);
  }
  return { contributions, completeBranchIds, incompleteBranchIds };
}

function hasPositiveCompleteCostForIncompleteLoc(
  incompleteBranchIds: readonly string[],
  phaseByBranch: ReadonlyMap<string, BranchPhaseAttributionResult>
): boolean {
  const incompleteIds = new Set(incompleteBranchIds);
  return [...phaseByBranch].some(
    ([branchId, attribution]) =>
      incompleteIds.has(branchId) &&
      attribution.coverage.completeness ===
        BranchPhaseAttributionCompleteness.Complete &&
      hasCompleteEventLevelCost(attribution) &&
      attribution.segments.some((segment) =>
        (segment.costEvents ?? []).some((event) => event.costUsd > 0)
      )
  );
}

/**
 * Prove that the selected rows represent the complete current file cache.
 * Both the cache writer and this analytics select are bounded at 500 rows, so
 * reaching that ceiling is ambiguous: the source may contain more rows than
 * were persisted. Such a branch must not contribute to a Complete LOC result.
 */
function hasCompleteCloudLocCache(row: CloudCanonicalMetricRow): boolean {
  return (
    row.branch.fileCacheStatus === BranchFileCacheStatus.Fresh &&
    row.branch.fileCacheFileCount === row.branch.fileChanges.length &&
    row.branch.fileCacheFileCount < BRANCH_ANALYTICS_FILE_CACHE_ROW_LIMIT
  );
}

function hasCompleteEventLevelCost(
  attribution: BranchPhaseAttributionResult
): boolean {
  return attribution.segments.every(
    (segment) =>
      segment.estimatedCostUsd === 0 || (segment.costEvents?.length ?? 0) > 0
  );
}

function sourcePullRequest(
  row: CloudCanonicalMetricRow,
  identity: string
): CloudMetricPullRequest | undefined {
  return row.pullRequestDetails.find((detail) => {
    const repositoryFullName =
      detail.repository?.fullName ??
      detail.repositoryFullName ??
      row.branch.repository?.fullName ??
      row.branch.repositoryFullName;
    if (repositoryFullName === null) {
      return false;
    }
    return (
      `${normalizeRepoFullName(repositoryFullName)}#${detail.number}` ===
      identity
    );
  });
}

/** Attach the cloud detail bundle after phase attribution is complete. */
export function attachCanonicalDetailMetrics(
  detail: Pick<BranchPageDetail, "associatedPullRequests" | "canonicalMetrics">,
  phaseAttribution: BranchPhaseAttributionResult,
  selectedPullRequestLoc: {
    additions: number | null;
    deletions: number | null;
  } | null,
  selectedCycleSuccessfulPushAt: string | null = null
): void {
  const metricPullRequests = detail.associatedPullRequests;
  const selectedMetricPullRequest = metricPullRequests?.items.find(
    (pullRequest) => pullRequest.id === metricPullRequests.selectedId
  );
  detail.canonicalMetrics = calculateBranchDetailMetrics({
    selectedPrAdditions: selectedPullRequestLoc?.additions ?? null,
    selectedPrDeletions: selectedPullRequestLoc?.deletions ?? null,
    selectedPrLocComplete:
      selectedPullRequestLoc?.additions !== null &&
      selectedPullRequestLoc?.additions !== undefined &&
      selectedPullRequestLoc.deletions !== null,
    phaseAttribution,
    selectedCycle: branchMetricCycleFromPullRequest(
      selectedMetricPullRequest ?? null,
      selectedCycleSuccessfulPushAt
    ),
  });
}

/** Resolves the selected PR cycle's persisted successful-push anchor. */
export function selectedCyclePushAt(
  detail: Pick<BranchPageDetail, "associatedPullRequests">,
  usage: SessionUsage,
  firstPushedAt: Date | null
): string | null {
  const lifecycleEvents = usage.lifecycleEventsBySession
    ? [...usage.lifecycleEventsBySession.values()].flat()
    : [];
  return selectedCycleSuccessfulPushAt(
    detail.associatedPullRequests,
    lifecycleEvents,
    firstPushedAt?.toISOString() ?? null
  );
}
