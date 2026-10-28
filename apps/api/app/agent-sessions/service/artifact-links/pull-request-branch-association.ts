import type {
  PersistedSessionPrRef,
  SyncedPullRequestArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  type BranchRefAggregate,
  branchRefAggregateFromPullRequestRef,
} from "./branch-ref-aggregate";

/** Build exact Branch-link evidence from a synced PR ref with a known head. */
export function branchAggregateFromPrRef(
  ref: SyncedPullRequestArtifactRef & { branchName: string },
  repositoryFullName: string
): BranchRefAggregate {
  return branchRefAggregateFromPullRequestRef(ref, {
    ...persistedSessionPrRefFromPullRequestRef(ref, repositoryFullName),
    repositoryFullName,
  });
}

function persistedSessionPrRefFromPullRequestRef(
  ref: SyncedPullRequestArtifactRef,
  repositoryFullName: string
): PersistedSessionPrRef {
  return {
    repositoryFullName,
    prNumber: ref.prNumber,
    relationTypes: [sessionPrRelationTypeFromArtifactRelation(ref.relation)],
  };
}

function sessionPrRelationTypeFromArtifactRelation(
  relation: ArtifactRefRelation
): SessionPrRelationType {
  if (relation === ArtifactRefRelation.Created) {
    return SessionPrRelationType.Created;
  }
  if (relation === ArtifactRefRelation.Reviewed) {
    return SessionPrRelationType.Reviewed;
  }
  return SessionPrRelationType.Referenced;
}

/**
 * Whether a PR ref carries the head branch name the PR lane needs before it
 * can write anything for it.
 *
 * `persistOneSessionPullRequestDetailRef` defers a ref without one BEFORE it
 * consults repository authority, so that deferral is a fact about the payload
 * and converges as soon as a delivery carries the name.
 *
 * Ask it only of the AGGREGATED ref the lane itself runs over:
 * `aggregatePullRequestArtifactRefs` collapses a session's refs to one per
 * `(repository, number)` and carries a name from any of them, so a caller
 * answering this per RAW ref disagrees with the lane on exactly the sessions
 * where two refs for one target differ. Nothing outside the lane answers it
 * for a target at all — `persistSessionPullRequestDetails` reports the
 * deferral instead.
 */
export function pullRequestRefCarriesHeadBranchName(
  ref: SyncedPullRequestArtifactRef
): ref is SyncedPullRequestArtifactRef & { branchName: string } {
  return Boolean(ref.branchName);
}
