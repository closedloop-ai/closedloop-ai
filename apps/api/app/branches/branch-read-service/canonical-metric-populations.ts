import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import { BranchPhaseAttributionCompletenessReason } from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import {
  type OrgMergedPullRequestAdmissionMap,
  readOrgMergedPullRequestAdmissionByBranchId,
} from "@/lib/pull-request-population";
import {
  type BranchMetricDenominatorCandidates,
  getGlobalBranchMetricDivisorCandidates,
} from "../branch-candidate-read";
import type { CloudCanonicalMetricRow } from "../branch-canonical-metric-projection";
import type { BranchListEnrichmentDomain } from "../branch-list-enrichment";
import type { BranchListQuery } from "../branch-list-query";
import {
  type BranchPushLocEvidence,
  type loadBranchPushLocAtoms,
  loadBranchPushLocAtomsInSnapshot,
} from "../branch-push-loc-read";
import { getSessionBranchCounts } from "../session-branch-divisor";
import type { getBranchLifetimeUsage } from "./session-usage-window";

type CanonicalMetricClient = Parameters<typeof getBranchLifetimeUsage>[0] &
  Parameters<typeof getGlobalBranchMetricDivisorCandidates>[0] &
  Parameters<typeof readOrgMergedPullRequestAdmissionByBranchId>[0];

export type GlobalDivisorCandidateMemo = Map<
  string,
  Promise<BranchMetricDenominatorCandidates>
>;

/** Create a request-local cache for repeated global divisor reads. */
export function createGlobalDivisorCandidateMemo(): GlobalDivisorCandidateMemo {
  return new Map();
}

/** Load the PRD-683 org merged-PR admission map for hydrated Branch metric rows. */
export function loadOrgMergedPullRequestAdmissionForRows(
  db: Parameters<typeof readOrgMergedPullRequestAdmissionByBranchId>[0],
  organizationId: string,
  rows: readonly CloudCanonicalMetricRow[]
): Promise<OrgMergedPullRequestAdmissionMap> {
  return readOrgMergedPullRequestAdmissionByBranchId(
    db,
    organizationId,
    rows.flatMap((row) =>
      hasOrgPullRequestMetricCandidate(row)
        ? [
            {
              branchArtifact: {
                id: row.id,
                _count: row._count,
              },
            },
          ]
        : []
    )
  );
}

function hasOrgPullRequestMetricCandidate(
  row: CloudCanonicalMetricRow
): boolean {
  return row.pullRequestDetails.some(
    (pullRequest) =>
      pullRequest.lastVerifiedAt !== null &&
      (pullRequest.prState === GitHubPRState.Merged ||
        pullRequest.prState === GitHubPRState.Closed)
  );
}

/** Load the global eligibility-aware Branch population for Session divisors. */
export function loadGlobalDivisorCandidates(
  db: CanonicalMetricClient,
  organizationId: string,
  globalQuery: BranchListQuery,
  memo?: GlobalDivisorCandidateMemo
): Promise<BranchMetricDenominatorCandidates> {
  const key = globalDivisorCandidateCacheKey(organizationId, globalQuery);
  const cached = memo?.get(key);
  if (cached) {
    return cached;
  }
  const candidates = getGlobalBranchMetricDivisorCandidates(
    db,
    organizationId,
    globalQuery
  );
  memo?.set(key, candidates);
  return candidates;
}

/** Load one Detail divisor or fail closed when global authority was capped. */
export async function loadCanonicalDetailDivisor(
  db: CanonicalMetricClient,
  organizationId: string,
  sessionIds: string[],
  globalQuery: BranchListQuery,
  memo?: GlobalDivisorCandidateMemo
): Promise<{
  branchCounts: Map<string, number>;
  coverageReasons: BranchPhaseAttributionCompletenessReason[];
}> {
  const candidates = await loadGlobalDivisorCandidates(
    db,
    organizationId,
    globalQuery,
    memo
  );
  if (!candidates.coverageComplete) {
    return {
      branchCounts: new Map(),
      coverageReasons: [
        BranchPhaseAttributionCompletenessReason.CoverageCapped,
      ],
    };
  }
  return {
    branchCounts: await getSessionBranchCounts(
      db,
      organizationId,
      sessionIds,
      candidates.ids
    ),
    coverageReasons: [],
  };
}

/**
 * The reads `projectCloudCanonicalMetrics` needs, issued together over the same
 * branch ids for both analytics entry points.
 */
export async function loadCanonicalMetricProjectionInputs(
  db: CanonicalMetricClient & Parameters<typeof loadBranchPushLocAtoms>[0],
  organizationId: string,
  rows: readonly CloudCanonicalMetricRow[],
  branchIds: readonly string[],
  enrichment: BranchListEnrichmentDomain
): Promise<{
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap;
  pushLocEvidence: BranchPushLocEvidence;
}> {
  const [orgMergedPullRequestAdmissionByBranchId, pushLocEvidence] =
    await Promise.all([
      loadOrgMergedPullRequestAdmissionForRows(db, organizationId, rows),
      loadBranchPushLocAtomsInSnapshot(
        db,
        organizationId,
        branchIds,
        enrichment
      ),
    ]);
  setAppSpanAttributes({
    "branches.analytics.push_loc.branch_count": pushLocEvidence.byBranchId.size,
    "branches.analytics.push_loc.truncated_branch_count":
      pushLocEvidence.truncatedBranchIds.size,
    "branches.analytics.push_loc.unusable_branch_count":
      pushLocEvidence.unusableByBranchId.size,
  });
  return { orgMergedPullRequestAdmissionByBranchId, pushLocEvidence };
}

function globalDivisorCandidateCacheKey(
  organizationId: string,
  globalQuery: BranchListQuery
): string {
  return `${organizationId}:${branchListCohortKey({
    ...globalQuery,
    startDate: undefined,
    endDate: undefined,
  })}`;
}
