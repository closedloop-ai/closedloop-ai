import { z } from "zod";
import type { BranchPageDetail } from "./branch.ts";
import { BranchParticipationKind, BranchStatus } from "./branch.ts";
import {
  BranchAssociatedPullRequestCompletenessReason,
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "./branch-associated-pull-request.ts";
import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "./branch-check-projection.ts";
import { ChecksStatus, ReviewDecision } from "./branch-checks.ts";
import { BranchMetricPullRequestOutcome } from "./branch-metrics.ts";
import type { CanonicalBranchProjectionV1 } from "./branch-projection.ts";
import {
  BranchSelectedPullRequestChecksAvailability,
  BranchSelectedPullRequestChecksSummary,
  BranchSelectedPullRequestChecksUnavailableSource,
} from "./branch-selected-pull-request-checks.ts";
import { GitHubAccessDenialReason } from "./github.ts";
import {
  GitHubPRState,
  StatusCheckRollupFailureReason,
} from "./github-status.ts";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "./selected-pull-request-checks-evidence.ts";
import { SelectedPullRequestEvidenceUnavailableReason } from "./selected-pull-request-evidence.ts";

/** Selection-dependent fields; sessions, commits and branch identity stay cached. */
export type BranchSelectedPullRequestDetailResponse = Pick<
  BranchPageDetail,
  (typeof selectedPullRequestDetailFields)[number]
> & {
  canonicalSelection?: {
    pullRequests: CanonicalBranchProjectionV1["common"]["pullRequests"];
    status: CanonicalBranchProjectionV1["list"]["status"];
    selectedPullRequest: CanonicalBranchProjectionV1["list"]["selectedPullRequest"];
    changes: CanonicalBranchProjectionV1["list"]["changes"];
  };
};

export function selectBranchPullRequestDetail(
  detail: BranchPageDetail
): BranchSelectedPullRequestDetailResponse {
  const selected: BranchSelectedPullRequestDetailResponse =
    partitionBranchDetail(detail).selected;
  const projection = detail.canonicalProjection;
  if (projection) {
    selected.canonicalSelection = {
      pullRequests: projection.common.pullRequests,
      status: projection.list.status,
      selectedPullRequest: projection.list.selectedPullRequest,
      changes: projection.list.changes,
    };
  }
  return selected;
}

export function mergeBranchPullRequestDetail(
  branch: BranchPageDetail,
  selection: BranchSelectedPullRequestDetailResponse
): BranchPageDetail {
  // Clear optional fields from the previous PR as well as replacing present ones.
  const { shared } = partitionBranchDetail(branch);
  const { canonicalSelection, ...selected } = selection;
  const result: BranchPageDetail = { ...shared, ...selected };
  if (branch.canonicalProjection && canonicalSelection) {
    const projection = branch.canonicalProjection;
    result.canonicalProjection = {
      ...projection,
      common: {
        ...projection.common,
        pullRequests: canonicalSelection.pullRequests,
      },
      list: {
        ...projection.list,
        status: canonicalSelection.status,
        selectedPullRequest: canonicalSelection.selectedPullRequest,
        changes: canonicalSelection.changes,
      },
    };
  }
  return result;
}

const selectedPullRequestDetailFields = [
  "associatedPullRequests",
  "selectedPullRequest",
  "selectedPullRequestChecks",
  "selectedPullRequestChecksProjection",
  "pullRequestRefreshPending",
  "status",
  "prNumber",
  "prTitle",
  "prState",
  "prUrl",
  "prBody",
  "prBodyHtmlUrl",
  "headSha",
  "mergeCommitSha",
  "mergedAt",
  "closedAt",
  "openedAt",
  "checksStatus",
  "checksPassed",
  "checksTotal",
  "reviewDecision",
  "additions",
  "deletions",
  "filesChanged",
  "reviewedParticipants",
  "reviewedParticipantsTruncated",
  "canonicalMetricCycle",
  "linkedPrNumbers",
] as const satisfies readonly (keyof BranchPageDetail)[];

function partitionBranchDetail(detail: BranchPageDetail) {
  const {
    associatedPullRequests,
    selectedPullRequest,
    selectedPullRequestChecks,
    selectedPullRequestChecksProjection,
    pullRequestRefreshPending,
    status,
    prNumber,
    prTitle,
    prState,
    prUrl,
    prBody,
    prBodyHtmlUrl,
    headSha,
    mergeCommitSha,
    mergedAt,
    closedAt,
    openedAt,
    checksStatus,
    checksPassed,
    checksTotal,
    reviewDecision,
    additions,
    deletions,
    filesChanged,
    reviewedParticipants,
    reviewedParticipantsTruncated,
    canonicalMetricCycle,
    linkedPrNumbers,
    canonicalProjection: _canonicalProjection,
    ...shared
  } = detail;
  const selected = {
    ...(associatedPullRequests === undefined ? {} : { associatedPullRequests }),
    ...(selectedPullRequest === undefined ? {} : { selectedPullRequest }),
    ...(selectedPullRequestChecks === undefined
      ? {}
      : { selectedPullRequestChecks }),
    ...(selectedPullRequestChecksProjection === undefined
      ? {}
      : { selectedPullRequestChecksProjection }),
    ...(pullRequestRefreshPending === undefined
      ? {}
      : { pullRequestRefreshPending }),
    status,
    prNumber,
    prTitle,
    prState,
    prUrl,
    prBody,
    prBodyHtmlUrl,
    headSha,
    mergeCommitSha,
    mergedAt,
    closedAt,
    openedAt,
    checksStatus,
    checksPassed,
    checksTotal,
    reviewDecision,
    additions,
    deletions,
    filesChanged,
    ...(reviewedParticipants === undefined ? {} : { reviewedParticipants }),
    ...(reviewedParticipantsTruncated === undefined
      ? {}
      : { reviewedParticipantsTruncated }),
    ...(canonicalMetricCycle === undefined ? {} : { canonicalMetricCycle }),
    linkedPrNumbers,
  };
  return { shared, selected };
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nullableString = z.string().nullable();
const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const changes = z.object({
  additions: count.nullable(),
  deletions: count.nullable(),
  filesChanged: count.nullable(),
});
const associatedPullRequest = z.object({
  id: z.string(),
  repositoryFullName: z.string(),
  number: count.positive(),
  title: nullableString,
  url: nullableString,
  state: z.enum(GitHubPRState),
  isDraft: z.boolean().nullable(),
  reviewDecision: z.enum(ReviewDecision).nullable(),
  openedAt: nullableTimestamp,
  closedAt: nullableTimestamp,
  mergedAt: nullableTimestamp,
  lifecycleObserved: z.boolean().optional(),
});
const completeness = z.object({
  state: z.enum(BranchAssociatedPullRequestCompletenessState),
  reasons: z.array(z.enum(BranchAssociatedPullRequestCompletenessReason)),
  provenance: z.enum(BranchAssociatedPullRequestProvenance),
});
const selectedPullRequest = associatedPullRequest.extend({
  body: nullableString,
  headRefOid: nullableString,
  mergeCommitSha: nullableString,
  changedFiles: count.nullable(),
  additions: count.nullable(),
  deletions: count.nullable(),
  baseRefName: nullableString.optional(),
  authorLogin: nullableString.optional(),
});
const checkProjection = z.object({
  headSha: z.string(),
  providerState: z.enum(BranchViewChecksProviderState),
  unavailableReason: z.enum(StatusCheckRollupFailureReason).nullable(),
  totalCount: count,
  truncated: z.boolean(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(BranchViewCheckKind),
      name: z.string(),
      status: nullableString,
      conclusion: nullableString,
      targetUrl: nullableString,
    })
  ),
});
const retryAfterSeconds = z
  .number()
  .finite()
  .nonnegative()
  .nullable()
  .optional();
const checksValue = z.object({
  identity: z.object({
    githubId: z.string(),
    repositoryFullName: z.string(),
    number: count.positive(),
    url: z.string(),
  }),
  revision: z.object({ headSha: z.string() }),
  checks: z.array(
    z.object({
      providerId: z.string(),
      sourceIdentity: z.string(),
      sourceKind: z.enum(SelectedPullRequestCheckSourceKind),
      sourceApp: z
        .object({
          nodeId: z.string(),
          databaseId: count.nullable(),
          slug: nullableString,
          name: z.string(),
          url: nullableString,
        })
        .nullable(),
      name: z.string(),
      providerStatus: z.string(),
      providerConclusion: nullableString,
      category: z.enum(SelectedPullRequestCheckCategory),
      createdAt: nullableTimestamp,
      startedAt: nullableTimestamp,
      completedAt: nullableTimestamp,
      targetUrl: nullableString,
    })
  ),
  counts: z.object({
    providerExpected: count,
    providerReturned: count,
    normalizedAttempts: count,
    emitted: count,
    total: count,
    successful: count,
    failing: count,
    pending: count,
    neutral: count,
  }),
  pagination: z.object({
    pageSize: count,
    pagesFetched: count,
    acquisitionMaximum: count,
    reachedAcquisitionMaximum: z.boolean(),
  }),
  history: z.object({
    mode: z.enum(SelectedPullRequestChecksHistoryMode),
    providerLimit: z.null(),
    rawAttempts: count,
    emittedSources: count,
  }),
  coverage: z.object({
    completeness: z.enum(SelectedPullRequestChecksCompleteness),
    reasons: z.array(z.enum(SelectedPullRequestChecksPartialReason)),
    interruption: z
      .object({
        reason: z.enum(SelectedPullRequestEvidenceUnavailableReason),
        retryAfterSeconds,
      })
      .optional(),
  }),
  summary: z.enum(BranchSelectedPullRequestChecksSummary),
});
const selectedChecks = z.union([
  z.object({
    status: z.literal(BranchSelectedPullRequestChecksAvailability.Available),
    value: checksValue,
  }),
  z.object({
    status: z.literal(BranchSelectedPullRequestChecksAvailability.Unavailable),
    source: z.literal(BranchSelectedPullRequestChecksUnavailableSource.Access),
    reason: z.enum(GitHubAccessDenialReason),
    retryAfterSeconds,
  }),
  z.object({
    status: z.literal(BranchSelectedPullRequestChecksAvailability.Unavailable),
    source: z.literal(
      BranchSelectedPullRequestChecksUnavailableSource.Evidence
    ),
    reason: z.enum(SelectedPullRequestEvidenceUnavailableReason),
    retryAfterSeconds,
  }),
]);

/** Validate the new projection at the HTTP trust boundary before caching it. */
export const branchSelectedPullRequestDetailResponseSchema = z.object({
  associatedPullRequests: z
    .object({
      items: z.array(associatedPullRequest),
      selectedId: nullableString,
      selectionReason: z.enum(BranchAssociatedPullRequestSelectionReason),
      completeness,
    })
    .optional(),
  selectedPullRequest: selectedPullRequest.nullable().optional(),
  selectedPullRequestChecks: selectedChecks.optional(),
  selectedPullRequestChecksProjection: checkProjection.optional(),
  pullRequestRefreshPending: z.literal(true).optional(),
  status: z.enum(BranchStatus),
  prNumber: count.positive().nullable(),
  prTitle: nullableString,
  prState: z.enum(GitHubPRState).nullable(),
  prUrl: nullableString,
  prBody: nullableString,
  prBodyHtmlUrl: nullableString,
  headSha: nullableString,
  mergeCommitSha: nullableString,
  mergedAt: nullableTimestamp,
  closedAt: nullableTimestamp,
  openedAt: nullableTimestamp,
  checksStatus: z.enum(ChecksStatus).nullable(),
  checksPassed: count.nullable(),
  checksTotal: count.nullable(),
  reviewDecision: z.enum(ReviewDecision).nullable(),
  additions: count.nullable(),
  deletions: count.nullable(),
  filesChanged: count.nullable(),
  reviewedParticipants: z
    .array(
      z.object({
        login: z.string(),
        avatarUrl: nullableString,
        participation: z.literal(BranchParticipationKind.Reviewed),
        state: z.union([
          z.literal(ReviewDecision.Approved),
          z.literal(ReviewDecision.ChangesRequested),
          z.literal(ReviewDecision.Commented),
        ]),
        submittedAt: timestamp,
        providerReviewId: z.string(),
        providerUrl: nullableString,
        prNumber: count.positive(),
      })
    )
    .optional(),
  reviewedParticipantsTruncated: z.boolean().optional(),
  canonicalMetricCycle: z
    .object({
      cycleId: z.string(),
      openedAt: nullableTimestamp,
      terminalAt: nullableTimestamp,
      outcome: z.enum(BranchMetricPullRequestOutcome),
      successfulPushes: z.array(
        z.object({ cycleId: z.string(), occurredAt: nullableTimestamp })
      ),
    })
    .nullable()
    .optional(),
  linkedPrNumbers: z.array(count.positive()),
  canonicalSelection: z
    .object({
      pullRequests: z.object({
        associatedCount: count,
        selected: associatedPullRequest.nullable(),
        selectionReason: z.enum(BranchAssociatedPullRequestSelectionReason),
        completeness,
      }),
      status: z.enum(BranchStatus),
      selectedPullRequest: z.object({
        id: nullableString,
        checksStatus: z.enum(ChecksStatus).nullable(),
        checksPassed: count.nullable(),
        checksTotal: count.nullable(),
      }),
      changes,
    })
    .optional(),
}) satisfies z.ZodType<BranchSelectedPullRequestDetailResponse>;
