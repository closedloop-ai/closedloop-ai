/**
 * Why the PR lane wrote no `PullRequestDetail` row for a target it ran over.
 *
 * `persistSessionPullRequestDetails` REPORTS this; nothing re-derives it from
 * the same `artifactRefs`. The re-derivation this replaces had to restate the
 * lane's aggregation, its head-branch predicate and its freshness gate, and
 * every one of the five defects reviewers found on PR #7621 was the two copies
 * disagreeing.
 *
 * Two members because the consumer's question is whether a LATER delivery can
 * land the row unaided — not why this one did not.
 */
export const PullRequestLaneDeferral = {
  /**
   * Nothing this delivery read from the provider stands in the way of a later
   * one landing the row: no ref for the target carried the head branch name —
   * the wire contract's documented shape for an older desktop parse, recorded
   * BEFORE the lane consults repository authority.
   */
  AwaitingDesktopDelivery: "awaiting_desktop_delivery",
  /**
   * The lane attempted the head branch and it would not materialize. Whether a
   * later delivery can still land the row depends on what the organization can
   * read for that repository — the caller's question, asked of
   * `serverRepositoryFetchAuthority`, not the lane's.
   *
   * The attempt is admitted by the ref's own head branch name, not by the
   * PR-link freshness gate — `resolvePrHeadBranchMaterialization` (ISS-9182)
   * carries why.
   */
  AwaitingRepositoryRead: "awaiting_repository_read",
} as const;
export type PullRequestLaneDeferral =
  (typeof PullRequestLaneDeferral)[keyof typeof PullRequestLaneDeferral];

/**
 * One entry per AGGREGATED target the lane deferred, keyed by
 * `sessionPullRequestDetailKey` — the same key space
 * `SessionPullRequestDetailMap` uses, because the lane decides both per
 * `(repository, number)` once `aggregatePullRequestArtifactRefs` has collapsed
 * a session's refs. A consumer holding a per-REF view of the same session
 * disagrees with the lane on exactly the sessions where two refs for one
 * target differ, and that seam is what produced PR #7621's defect (2).
 *
 * A target ABSENT from this map is one the lane RESOLVED or never ran over,
 * and both of those a `PullRequestDetail` existence read can settle. So the
 * lane reports what it deferred, never what it claims.
 */
export type SessionPullRequestLaneDeferralMap = Map<
  string,
  PullRequestLaneDeferral
>;

/**
 * Exhaustive rather than a `===` against one member: a member added later
 * would compile and fall silently to whichever side the comparison omits.
 * Here it fails `tsc` until someone judges which convergence it has.
 */
const PULL_REQUEST_LANE_DEFERRAL_AWAITS_REPOSITORY_READ: Record<
  PullRequestLaneDeferral,
  boolean
> = {
  [PullRequestLaneDeferral.AwaitingDesktopDelivery]: false,
  [PullRequestLaneDeferral.AwaitingRepositoryRead]: true,
};

export function pullRequestLaneDeferralAwaitsRepositoryRead(
  deferral: PullRequestLaneDeferral
): boolean {
  return PULL_REQUEST_LANE_DEFERRAL_AWAITS_REPOSITORY_READ[deferral];
}
