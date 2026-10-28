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
  isUnobservedPullRequest,
  selectBranchAssociatedPullRequests,
} from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { deriveBranchMergedState } from "@repo/api/src/types/branch-merged-state";
import { toBranchStatus } from "@repo/api/src/types/branch-status-derivation";
import { hasObservedPullRequestEvidence } from "@repo/api/src/types/pull-request-lifecycle-observation";
import { branchOwnsPullRequestDetail } from "./branch-canonical-pull-request";
import { BRANCH_REVIEWED_PARTICIPANTS_LIMIT } from "./branch-read-selects";
import { selectedPullRequestRepositoryFullName } from "./selected-pull-request-repository-identity";

/** Project every persisted cloud PR linked to a Branch through the shared selector. */
export function projectCloudBranchAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  return projectAssociatedPullRequests(row);
}

/** Preserve linked history but expose a default only when the Branch owns it. */
export function projectCloudOwnedBranchAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  const associated = projectAssociatedPullRequests(row);
  if (
    !associated.selected ||
    branchOwnsSelectedPullRequest(row, associated.selected)
  ) {
    return associated;
  }
  return {
    collection: {
      ...associated.collection,
      selectedId: null,
      selectionReason: BranchAssociatedPullRequestSelectionReason.None,
    },
    selected: null,
  };
}

function branchOwnsSelectedPullRequest<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>,
  selected: CloudAssociatedPullRequestCandidate<Detail>
): boolean {
  if (!row.branch) {
    return false;
  }
  return branchOwnsPullRequestDetail(row.branch, selected.source);
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
        selectedPullRequestRepositoryFullName(row, detail) ===
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

function projectAssociatedPullRequests<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): BranchAssociatedPullRequestSelection<
  CloudAssociatedPullRequestCandidate<Detail>
> {
  return selectBranchAssociatedPullRequests(
    cloudAssociatedPullRequestCandidates(row),
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

/**
 * Preserve existing Branch status semantics while changing PR selection
 * authority.
 *
 * ISS-8422: a selected PR nobody observed is derived as NO connected PR — the
 * same branch-level verdict a branch with no PR at all gets, rather than the
 * `pr_state` column default restated as a measurement. Kerensa ruled 2026-08-31
 * that this is the correct target: `BranchStatus.Open` is a statement about the
 * BRANCH (a PR-less branch already derives it), not a claim about a PR, so no
 * new status member is needed and none was added.
 */
export function statusForSelectedCloudPullRequest(
  artifactStatus: string,
  selected: SelectedCloudPullRequestCandidate | null
) {
  const observedPrState = observedPrStateForSelectedCloudPullRequest(selected);
  const hasObservedPr = observedPrState !== null;
  const mergedState = deriveBranchMergedState({
    connectedPrState: observedPrState,
    connectedMergedAt: hasObservedPr
      ? (selected?.source.mergedAt ?? null)
      : null,
    hasConnectedPrEvidence: hasObservedPr,
    localArtifactStatus: artifactStatus,
  });
  return toBranchStatus(
    artifactStatus,
    observedPrState,
    hasObservedPr ? (selected?.source.isDraft ?? false) : false,
    mergedState
  );
}

/**
 * The selected PR's lifecycle state AS MEASURED, or null when no producer ever
 * observed it (ISS-8422). `pr_state` is `NOT NULL` with a `@default(OPEN)`, so
 * reading the column straight through reports a schema default as a
 * measurement; the row-level `prState` field is already NULL-legal on the wire
 * (`packages/api/src/types/branch.ts`), which is what makes emitting null here
 * additive rather than a contract change.
 */
export function observedPrStateForSelectedCloudPullRequest(
  selected: SelectedCloudPullRequestCandidate | null
): CloudPullRequestProjectionInput["prState"] {
  if (!selected) {
    return null;
  }
  // The candidate's OWN resolved verdict, not a re-derivation from its raw row.
  // Recomputing here answered a different question than selection had: the
  // selector resolves observation across every duplicate snapshot of a PR,
  // while the raw row is only the newest of them, so a factless re-sync of a
  // PR observed earlier reported a null state for a row selection had accepted
  // as observed (davetho review on #6313). An absent flag means observed, per
  // the shared candidate contract.
  return isUnobservedPullRequest(selected) ? null : selected.source.prState;
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
    repository: {
      fullName: string;
      githubRepoId?: string | null;
    } | null;
  } | null;
  pullRequestDetails: readonly Detail[];
};

export type CloudPullRequestProjectionInput = {
  branchArtifactId: string;
  repositoryId: string | null;
  repositoryFullName?: string | null;
  repository?: {
    fullName: string;
    githubRepoId?: string | null;
  } | null;
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
  // ISS-8422: observed facts, not rendered fields — a row carrying LOC was
  // fetched from the provider. Every select that feeds this input carries all
  // three, so that one consumer cannot classify a row as observed while another
  // calls the same row factless (davetho review on #6313).
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
};

/**
 * The selected candidate as the shared selector returns it: the raw row plus the
 * observation verdict RESOLVED across every duplicate snapshot of that PR.
 * Status derivation reads the verdict, never the row's own fields.
 */
type SelectedCloudPullRequestCandidate = {
  lifecycleObserved?: boolean;
  source: Pick<
    CloudPullRequestProjectionInput,
    "isDraft" | "mergedAt" | "prState"
  >;
};

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

/** Map a cloud branch row's own PR details into shared selector candidates. */
export function cloudAssociatedPullRequestCandidates<
  Detail extends CloudPullRequestProjectionInput,
>(
  row: CloudBranchProjectionInput<Detail>
): CloudAssociatedPullRequestCandidate<Detail>[] {
  return row.pullRequestDetails
    .filter((detail) => detail.branchArtifactId === row.id)
    .map((detail) => ({
      source: detail,
      repositoryFullName: selectedPullRequestRepositoryFullName(row, detail),
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
      // ISS-8422: only a producer reading the raw row can say this. The cloud
      // `pr_state` column is NOT NULL with a `@default(OPEN)`, so an
      // unwritten state reads as a measurement; the shared selector must not
      // guess that from a provenance token, because callers that build a
      // candidate from an already-corrected cloud response pass the same one.
      lifecycleObserved: hasObservedPullRequestEvidence({
        prState: detail.prState,
        isDraft: detail.isDraft,
        title: detail.title,
        reviewDecision: detail.reviewDecision,
        additions: detail.additions,
        deletions: detail.deletions,
        changedFiles: detail.changedFiles,
        mergedAt: detail.mergedAt,
        closedAt: detail.closedAt,
        githubCreatedAt: detail.githubCreatedAt,
      }),
    }));
}
