/**
 * Shared helper for constructing the `PullRequestDetail` row shape that the
 * webhook handlers read from Prisma. Each handler `.select`s a different
 * subset of columns, so this helper accepts a superset and returns a row
 * that covers all of them — handlers pick the fields they care about.
 *
 * Direction semantics: by the canonical ArtifactLink convention the PR is
 * the TARGET of a DOCUMENT → produces → PR edge. Handlers that look up the
 * producing document correctly should query `artifact.targetLinks`.
 * Defaults here populate `targetLinks` from `linkedDoc` and leave
 * `sourceLinks` empty so a handler that queries the wrong relation returns
 * no match — a symmetric fixture would hide exactly the direction-mismatch
 * bug category we want to surface in tests.
 */
export type MakePrDetailRowInput = {
  artifactId: string;
  id?: string;
  branchArtifactId?: string | null;
  currentPullRequestDetailId?: string | null;
  workstreamId?: string | null;
  organizationId?: string;
  number?: number;
  checksStatus?: string;
  reviewDecision?: string | null;
  prState?: string;
  isDraft?: boolean;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  headSha?: string | null;
  title?: string;
  externalUrl?: string;
  /**
   * Shorthand for the "the DOCUMENT that produces this PR is present on
   * `artifact.targetLinks[0].source`" case. If set, it populates
   * `targetLinks`; `sourceLinks` stays empty. Override either independently
   * via `sourceLinks` / `targetLinks` for edge-case tests.
   */
  linkedDoc?: { id: string; slug: string } | null;
  sourceLinks?: Array<{ source: { id: string; slug: string } }>;
  targetLinks?: Array<{ source: { id: string; slug: string } }>;
  branchTargetLinks?: Array<{ source: { id: string; slug: string } }>;
};

export function makePrDetailRow(partial: MakePrDetailRowInput) {
  const branchArtifactId =
    partial.branchArtifactId === undefined
      ? partial.artifactId
      : partial.branchArtifactId;
  const derivedTargetLinks = partial.linkedDoc
    ? [{ source: { id: partial.linkedDoc.id, slug: partial.linkedDoc.slug } }]
    : [];
  return {
    id: partial.id ?? partial.artifactId,
    artifactId: partial.artifactId,
    branchArtifactId,
    number: partial.number ?? 0,
    checksStatus: partial.checksStatus ?? "UNKNOWN",
    reviewDecision: partial.reviewDecision ?? null,
    prState: partial.prState ?? "OPEN",
    isDraft: partial.isDraft ?? false,
    closedAt: partial.closedAt ?? null,
    mergedAt: partial.mergedAt ?? null,
    headSha: partial.headSha ?? null,
    artifact: {
      name: partial.title ?? "",
      externalUrl: partial.externalUrl ?? "",
      organizationId: partial.organizationId ?? "",
      workstreamId: partial.workstreamId ?? null,
      sourceLinks: partial.sourceLinks ?? [],
      targetLinks: partial.targetLinks ?? derivedTargetLinks,
    },
    branchArtifact:
      branchArtifactId === null
        ? null
        : {
            organizationId: partial.organizationId ?? "",
            projectId: "",
            workstreamId: partial.workstreamId ?? null,
            branch: {
              checksStatus: partial.checksStatus ?? "UNKNOWN",
              currentPullRequestDetailId:
                "currentPullRequestDetailId" in partial
                  ? partial.currentPullRequestDetailId
                  : (partial.id ?? partial.artifactId),
              headSha: partial.headSha ?? null,
            },
            targetLinks: partial.branchTargetLinks ?? derivedTargetLinks,
          },
  };
}
