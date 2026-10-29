import { deterministicUuid } from "./helpers";

/**
 * The PR-comment proof fixtures' artifact identities, kept free of the
 * generated client so the non-empty-org guard can recognize them.
 */
export const PullRequestCommentProofFixture = {
  Complete: "complete",
  MissingLane: "missing-lane",
} as const;
export type PullRequestCommentProofFixture =
  (typeof PullRequestCommentProofFixture)[keyof typeof PullRequestCommentProofFixture];

export function pullRequestCommentProofIdentity(
  organizationId: string,
  fixture: PullRequestCommentProofFixture
) {
  const orgPrefix = organizationId.slice(0, 8);
  return {
    branchArtifactId: deterministicUuid(
      `artifact:branch:${organizationId}:pr-comment-proof-${fixture}`
    ),
    branchSlug: `seed-pr-comment-proof-${fixture}-${orgPrefix}`,
    sessionArtifactId: deterministicUuid(
      `artifact:session:${organizationId}:pr-comment-proof-${fixture}`
    ),
    sessionSlug: `seed-pr-comment-proof-session-${fixture}-${orgPrefix}`,
  };
}

/**
 * The id the proof seed mints for an artifact carrying `slug`, or `undefined`
 * when the slug is not one of its Branches or Sessions.
 */
export function pullRequestCommentProofArtifactId(
  slug: string,
  organizationId: string
): string | undefined {
  for (const fixture of Object.values(PullRequestCommentProofFixture)) {
    const identity = pullRequestCommentProofIdentity(organizationId, fixture);
    if (slug === identity.branchSlug) {
      return identity.branchArtifactId;
    }
    if (slug === identity.sessionSlug) {
      return identity.sessionArtifactId;
    }
  }
  return;
}
