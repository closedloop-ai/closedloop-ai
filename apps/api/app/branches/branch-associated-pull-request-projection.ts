import {
  BranchParticipationKind,
  type BranchReviewedParticipant,
} from "@repo/api/src/types/branch";
import {
  type BranchAssociatedPullRequestCandidate,
  BranchAssociatedPullRequestProvenance,
  type BranchAssociatedPullRequestSelection,
  BranchAssociatedPullRequestSelectionReason,
  type BranchSelectedPullRequestIdentity,
  selectBranchAssociatedPullRequests,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { deriveBranchMergedState } from "@repo/api/src/types/branch-merged-state";
import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { BRANCH_REVIEWED_PARTICIPANTS_LIMIT } from "./branch-read-selects";
import { toBranchStatus } from "./branch-status-derivation";

/** Project every persisted cloud PR owned by a Branch through the shared selector. */
export function projectCloudBranchAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  return projectAssociatedPullRequests(row);
}

/** Detail variant preserves review rows on the selected source record. */
export function projectCloudBranchDetailAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  return projectAssociatedPullRequests(row);
}

/**
 * Resolve an explicit identity only from the persisted associated collection.
 * Omission retains the deterministic default; a foreign identity fails closed.
 */
export function resolveCloudBranchAssociatedPullRequest<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>,
  selection: BranchAssociatedPullRequestSelection<
    CloudAssociatedPullRequestCandidate<Detail>
  >,
  requested?: BranchSelectedPullRequestIdentity
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> | null {
  if (!requested) {
    return selection;
  }
  const repositoryFullName = requested.repositoryFullName;
  const selected = selection.collection.items.find(
    (candidate) =>
      candidate.repositoryFullName === repositoryFullName &&
      candidate.number === requested.pullRequestNumber
  );
  if (!selected) {
    return null;
  }
  const persisted = projectAssociatedPullRequests({
    ...row,
    pullRequestDetails: row.pullRequestDetails.filter(
      (detail) =>
        detail.number === selected.number &&
        pullRequestRepositoryFullName(row, detail) ===
          selected.repositoryFullName
    ),
  }).selected;
  if (!persisted) {
    return null;
  }
  return {
    collection: {
      ...selection.collection,
      selectedId: selected.id,
      selectionReason: BranchAssociatedPullRequestSelectionReason.Explicit,
    },
    selected: persisted,
  };
}

function pullRequestRepositoryFullName<
  Detail extends CloudPullRequestProjectionInput,
>(row: CloudBranchProjectionInput<Detail>, detail: Detail): string | null {
  const fullName =
    detail.repository?.fullName ??
    detail.repositoryFullName ??
    row.branch?.repository?.fullName ??
    row.branch?.repositoryFullName;
  return fullName ? normalizeRepoFullName(fullName) : null;
}

function projectAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  const branchRepositoryFullName =
    row.branch?.repository?.fullName ?? row.branch?.repositoryFullName ?? null;
  const candidates: CloudAssociatedPullRequestCandidate<Detail>[] =
    row.pullRequestDetails
      .filter((detail) => detail.branchArtifactId === row.id)
      .map((detail) => ({
        source: detail,
        repositoryFullName:
          detail.repository?.fullName ??
          detail.repositoryFullName ??
          branchRepositoryFullName,
        number: detail.number,
        title: detail.title,
        url: detail.htmlUrl,
        state: detail.prState,
        isDraft: detail.isDraft,
        reviewDecision: detail.reviewDecision,
        openedAt: toIso(detail.githubCreatedAt),
        closedAt: toIso(detail.closedAt),
        mergedAt: toIso(detail.mergedAt),
        observedAt: toIso(detail.lastVerifiedAt),
      }));
  return selectBranchAssociatedPullRequests(
    candidates,
    BranchAssociatedPullRequestProvenance.PersistedCloud
  );
}

export type CloudAssociatedPullRequestCandidate<
  Detail extends
    CloudPullRequestProjectionInput = CloudPullRequestProjectionInput,
> = BranchAssociatedPullRequestCandidate & { source: Detail };

/** Project selected-PR review participation without growing the Branch service. */
export function projectCloudReviewedParticipants(
  pullRequest: CloudReviewedPullRequest | null
): {
  participants: BranchReviewedParticipant[];
  truncated: boolean;
} {
  if (!pullRequest) {
    return { participants: [], truncated: false };
  }
  const participants: BranchReviewedParticipant[] = [];
  for (const review of pullRequest.reviews.slice(
    0,
    BRANCH_REVIEWED_PARTICIPANTS_LIMIT
  )) {
    if (!(review.authorLogin && review.state !== ReviewDecision.Dismissed)) {
      continue;
    }
    participants.push({
      login: review.authorLogin,
      avatarUrl: review.authorAvatarUrl,
      participation: BranchParticipationKind.Reviewed,
      state: review.state,
      submittedAt: review.submittedAt.toISOString(),
      providerReviewId: review.githubReviewId,
      providerUrl: review.htmlUrl,
      prNumber: pullRequest.number,
    });
  }
  return {
    participants,
    truncated: pullRequest.reviews.length > BRANCH_REVIEWED_PARTICIPANTS_LIMIT,
  };
}

/** Preserve existing Branch status semantics while changing PR selection authority. */
export function statusForSelectedCloudPullRequest(
  artifactStatus: string,
  selected: CloudStatusPullRequest | null
) {
  const mergedState = deriveBranchMergedState({
    connectedPrState: selected?.prState ?? null,
    connectedMergedAt: selected?.mergedAt ?? null,
    hasConnectedPrEvidence: Boolean(selected),
    localArtifactStatus: artifactStatus,
  });
  return toBranchStatus(
    artifactStatus,
    selected?.prState ?? null,
    selected?.isDraft ?? false,
    mergedState
  );
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export type CloudBranchProjectionInput<
  Detail extends CloudPullRequestProjectionInput,
> = {
  id: string;
  branch: {
    repositoryId: string | null;
    repositoryFullName: string | null;
    repository: { fullName: string } | null;
  } | null;
  pullRequestDetails: readonly Detail[];
};

export type CloudPullRequestProjectionInput = {
  branchArtifactId: string;
  repositoryId: string | null;
  repositoryFullName?: string | null;
  repository?: { fullName: string } | null;
  number: number;
  title: string | null;
  htmlUrl: string | null;
  prState: BranchAssociatedPullRequestCandidate["state"];
  isDraft: boolean;
  reviewDecision: BranchAssociatedPullRequestCandidate["reviewDecision"];
  githubCreatedAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  lastVerifiedAt: Date | null;
};

type CloudStatusPullRequest = Pick<
  CloudPullRequestProjectionInput,
  "isDraft" | "mergedAt" | "prState"
>;

type CloudReviewedPullRequest = {
  number: number;
  reviews: readonly {
    authorLogin: string | null;
    authorAvatarUrl: string | null;
    state: ReviewDecision;
    submittedAt: Date;
    githubReviewId: string;
    htmlUrl: string | null;
  }[];
};
