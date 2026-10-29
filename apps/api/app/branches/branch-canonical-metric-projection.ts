import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  associatedPullRequestsWithholdDecisions,
  BranchAssociatedPullRequestProvenance,
  metricAssociatedPullRequestCollection,
} from "@repo/api/src/types/branch-associated-pull-request";
import { resolveAttributedBranchCost } from "@repo/api/src/types/branch-cost";
import type { BranchListMetricBundle } from "@repo/api/src/types/branch-metrics";
import type { BranchPhaseAttributionResult } from "@repo/api/src/types/branch-phase-attribution";
import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import {
  branchMetricCycleFromPullRequest,
  calculateBranchDetailMetrics,
  selectedCycleSuccessfulPushAt,
} from "@repo/lib/branches/branch-detail-outcomes";
import type { BranchPenseroPointsInput } from "@repo/lib/branches/branch-detail-pensero-points";
import { resolveBranchLastActiveMetric } from "@repo/lib/branches/branch-last-active";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import type { BranchMetricPullRequestFacts } from "@repo/lib/branches/branch-pull-request-metrics";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import type { OrgMergedPullRequestAdmissionMap } from "@/lib/pull-request-population";
import {
  type CanonicalCloudBranchActivityAtom,
  latestEligibleCloudBranchActivityAtom,
} from "./branch-activity-canonical-read";
import {
  type CloudBranchProjectionInput,
  type CloudPullRequestProjectionInput,
  cloudAssociatedPullRequestCandidates,
  projectCloudOwnedBranchAssociatedPullRequests,
  statusForSelectedCloudPullRequest,
} from "./branch-associated-pull-request-projection";
import type { BranchPenseroNumerator } from "./branch-pensero-numerator";
import { cloudPublicationLocEvidence } from "./branch-publication-loc-projection";
import type {
  BranchPushLocAtom,
  UnusableBranchPushLocAtom,
} from "./branch-push-loc-read";
import type { BranchFileChangeTotals } from "./branch-read-service/file-change-totals-read";
import type { SessionUsage } from "./branch-read-service/session-usage-window";

type CloudMetricPullRequest = CloudPullRequestProjectionInput & {
  id: string;
  githubId: string | null;
  additions: number | null;
  deletions: number | null;
  headRefOid: string | null;
  headRefName: string | null;
  headRepositoryFullName: string | null;
};

export type CloudCanonicalMetricRow =
  CloudBranchProjectionInput<CloudMetricPullRequest> & {
    status: string;
    _count: { pullRequestDetails: number };
    branch: NonNullable<
      CloudBranchProjectionInput<CloudMetricPullRequest>["branch"]
    > & {
      activityAtoms: readonly CanonicalCloudBranchActivityAtom[];
      /**
       * ISS-10009 part 2: the branch's captured per-push LOC atoms, attached by
       * `withBranchPushLocEvidence`.
       *
       * OPTIONAL because the SELECT row types feed this one directly — the three
       * metric call sites pass a freshly hydrated `BranchAnalyticsArtifactRow` /
       * `BranchDetailArtifactRow` into the attach helper inline — so requiring
       * the fields here does not compile without a second pre-attach row type
       * threaded through those reads. A caller that omits the attach therefore
       * gets the no-capture answer (a disclosed gap, never a synthesized total)
       * rather than a compile error, and what pins the three real call sites
       * against that is `branch-read-service.push-loc-wiring.test.ts`.
       */
      pushLocAtoms?: readonly BranchPushLocAtom[];
      /** Captured pushes with no usable sha range, disclosed not discarded. */
      unusablePushLocAtoms?: readonly UnusableBranchPushLocAtom[];
      /** This row's push read filled its chunk cap, so its set may be short. */
      pushLocEvidenceTruncated?: boolean;
      branchName: string;
      /**
       * ISS-12309: read only by the Active fold. Optional for the same reason
       * `pushLocAtoms` is — the SELECT row types feed this one directly, and a
       * producer that omits it gets the pre-ISS-12309 answer.
       */
      deletedAt?: Date | null;
      firstPushedAt: Date | null;
      pushSource: string | null;
      headSha: string | null;
      headShaSource: string | null;
      headShaObservedAt: Date | null;
      fileCacheStatus: string;
      fileCacheHeadSha: string | null;
      fileCacheCapped: boolean;
      fileCacheFileCount: number;
      fileChangeTotals: BranchFileChangeTotals;
    };
  };

/**
 * Project one cloud row's Last active through the shared definition: its
 * latest immutable activity atom, else its linked sessions (ISS-11915).
 */
export function projectCloudCanonicalLastActive(
  row: CloudCanonicalActivityRow
) {
  const event = canonicalCloudAtomEvent(row);
  const linkedSessionActivityAt = row.branch.linkedSessionActivityAt ?? null;
  return resolveBranchLastActiveMetric(
    event ? [event] : [],
    linkedSessionActivityAt === null
      ? []
      : [
          {
            sessionId: `branch:${row.id}:linked-sessions`,
            lastActivityAt: linkedSessionActivityAt,
          },
        ]
  );
}

/** Build the cloud list bundle from the full non-date-filtered cohort. */
export function projectCloudCanonicalMetrics(
  rows: readonly CloudCanonicalMetricRow[],
  query: { startDate?: Date; endDate?: Date },
  requestBoundary: Date,
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap,
  /**
   * ISS-11117: the cohort's Pensero delivery points, read at the ROUTE and
   * threaded in — never read here.
   *
   * `readPenseroBranchDeliveryPoints` opens its own `RepeatableRead`
   * transaction and `withDb.tx` THROWS rather than join a weaker ambient one,
   * and this function runs inside the branch read snapshot. Same division of
   * labour the detail path already makes (`[id]/route.ts` →
   * `attachCanonicalDetailMetrics`).
   *
   * Absent — the default — is the AC2 state: no Pensero numerator, so the
   * cohort's LOC/$ card renders exactly as today.
   */
  penseroPoints?: BranchPenseroPointsInput | null,
  /** ISS-12346: Median PR size and Merge rate, folded in SQL for the cohort. */
  pullRequestFacts?: BranchMetricPullRequestFacts,
  /** ISS-12346: AI spend, folded in SQL for the cohort. */
  costFacts?: BranchMetricCostFacts
): BranchListMetricBundle {
  setAppSpanAttributes({
    "branches.analytics.canonical_metrics_projection.row_count": rows.length,
    "branches.analytics.canonical_metrics_projection.date_bounded": Boolean(
      query.startDate || query.endDate
    ),
  });
  const projections = rows.map((row) => ({
    row,
    associated: projectCloudOwnedBranchAssociatedPullRequests(row),
    activity: canonicalCloudActivityEvent(row),
  }));
  const locEvidence = cloudPublicationLocEvidence(
    rows,
    orgMergedPullRequestAdmissionByBranchId
  );
  setAppSpanAttributes({
    "branches.analytics.canonical_metrics_projection.loc_complete_branch_count":
      locEvidence.completeBranchIds.length,
  });
  return projectCanonicalBranchListMetrics({
    branches: projections.map(({ row, associated, activity }) => ({
      id: row.id,
      status: statusForSelectedCloudPullRequest(
        row.status,
        associated.selected ?? null
      ),
      // Omission preserved: a row whose read did not select `deletedAt` says
      // nothing about deletion, which is not the same as saying it is live.
      ...(row.branch.deletedAt === undefined
        ? {}
        : { deleted: row.branch.deletedAt !== null }),
      lastActivityAt: activity?.occurredAt ?? null,
    })),
    ...(pullRequestFacts ? { pullRequestFacts } : {}),
    // ISS-9959: name WHICH branches actually hide a decided pull request, so the
    // kernel can answer per window instead of letting one bad branch anywhere in
    // the org star every non-count card forever. An ambiguity among pull requests
    // this projection DID read hides no merge and no unmerged close, so it
    // contributes no gap; every other shortfall does, and carries no instant,
    // because the branch's own last activity is not an upper bound on a decision
    // that was never observed.
    //
    // Still read HERE, and not from the SQL fold, because the gap is a pull
    // request the sync never wrote: it is absent from `pull_request_detail`, so
    // no statement over that table can see it (H1, marisolashgrove review on #8791).
    pullRequestCoverageGaps: rows.flatMap((row) =>
      associatedPullRequestsWithholdDecisions(
        metricAssociatedPullRequestCollection(
          cloudAssociatedPullRequestCandidates(row),
          BranchAssociatedPullRequestProvenance.PersistedCloud
        )
      )
        ? [{ branchId: row.id, occurredAt: null }]
        : []
    ),
    ...(costFacts ? { costFacts } : {}),
    lastActiveEvents: projections.flatMap(({ activity }) =>
      activity ? [activity] : []
    ),
    // A latest-only projection cannot claim complete historical coverage.
    lastActiveCoverageComplete: false,
    locContributions: locEvidence.contributions,
    locCoverageGaps: locEvidence.coverageGaps,
    locCompleteBranchIds: locEvidence.completeBranchIds,
    // ISS-11117: omitted when absent, never serialized as a value.
    ...(penseroPoints ? { penseroPoints } : {}),
    locCoverageComplete: locEvidence.coverageComplete,
    startDate: query.startDate,
    endDate: query.endDate,
    now: requestBoundary,
  });
}

type CloudCanonicalActivityRow = {
  id: string;
  pullRequestDetails: readonly { id: string; branchArtifactId: string }[];
  branch: {
    activityAtoms: readonly CanonicalCloudBranchActivityAtom[];
    /** ISS-11915 fallback, attached by `applyBranchCandidateActivitySnapshot`. */
    linkedSessionActivityAt?: Date | null;
  };
};

/** The row's resolved Last active as one cohort event, or none. */
function canonicalCloudActivityEvent(row: CloudCanonicalActivityRow):
  | {
      sourceEventId: string;
      occurredAt: string;
    }
  | undefined {
  const lastActive = projectCloudCanonicalLastActive(row);
  if (lastActive.value === null) {
    return;
  }
  return { sourceEventId: `branch:${row.id}`, occurredAt: lastActive.value };
}

function canonicalCloudAtomEvent(row: CloudCanonicalActivityRow):
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

/** Attach the cloud detail bundle after phase attribution is complete. */
export function attachCanonicalDetailMetrics(
  detail: Pick<
    BranchPageDetail,
    | "associatedPullRequests"
    | "canonicalMetrics"
    | "canonicalMetricCycle"
    | "estimatedCostUsd"
    | "attributedCostUsd"
  >,
  phaseAttribution: BranchPhaseAttributionResult,
  selectedPullRequestLoc: {
    additions: number | null;
    deletions: number | null;
  } | null,
  selectedCycleSuccessfulPushAt: string | null = null,
  lifetimeLocEvidence?: ReturnType<typeof cloudPublicationLocEvidence>,
  qualifyingSessionCount?: number,
  /**
   * ISS-9814: the branch's Pensero points, or null/absent when it has none.
   * Read at the route (`branch-pensero-numerator.ts`) and given its failed-day
   * flag by `getBranchDetail` (ISS-10653), never here — this function is
   * synchronous and runs inside the detail read's transaction.
   */
  penseroPoints?: BranchPenseroNumerator | null
): void {
  const metricPullRequests = detail.associatedPullRequests;
  const selectedMetricPullRequest = metricPullRequests?.items.find(
    (pullRequest) => pullRequest.id === metricPullRequests.selectedId
  );
  detail.canonicalMetricCycle = branchMetricCycleFromPullRequest(
    selectedMetricPullRequest ?? null,
    selectedCycleSuccessfulPushAt
  );
  detail.canonicalMetrics = calculateBranchDetailMetrics({
    // ISS-6949: read off the same object the metrics are written onto, so a
    // caller cannot pair one branch's metrics with another's cost.
    attributedCostUsd: resolveAttributedBranchCost(detail),
    selectedPrAdditions: selectedPullRequestLoc?.additions ?? null,
    selectedPrDeletions: selectedPullRequestLoc?.deletions ?? null,
    selectedPrLocComplete:
      selectedPullRequestLoc?.additions !== null &&
      selectedPullRequestLoc?.additions !== undefined &&
      selectedPullRequestLoc.deletions !== null,
    ...(lifetimeLocEvidence
      ? {
          lifetimeLocContributions: lifetimeLocEvidence.contributions,
          lifetimeLocCoverageComplete: lifetimeLocEvidence.coverageComplete,
        }
      : {}),
    ...(qualifyingSessionCount === undefined ? {} : { qualifyingSessionCount }),
    // Omitted, never sent as an explicit null, when there is no numerator: the
    // kernel keys "no Pensero metric" on the field's ABSENCE, and an absent
    // optional is also what a version-skewed consumer expects to see.
    ...(penseroPoints ? { penseroPoints } : {}),
    phaseAttribution,
    selectedCycle: detail.canonicalMetricCycle,
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
