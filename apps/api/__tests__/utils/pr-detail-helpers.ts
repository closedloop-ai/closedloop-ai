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
  workstreamId?: string | null;
  organizationId?: string;
  number?: number;
  checksStatus?: string;
  reviewDecision?: string | null;
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
};

export function makePrDetailRow(partial: MakePrDetailRowInput) {
  const derivedTargetLinks = partial.linkedDoc
    ? [{ source: { id: partial.linkedDoc.id, slug: partial.linkedDoc.slug } }]
    : [];
  return {
    artifactId: partial.artifactId,
    number: partial.number ?? 0,
    checksStatus: partial.checksStatus ?? "UNKNOWN",
    reviewDecision: partial.reviewDecision ?? null,
    headSha: partial.headSha ?? null,
    artifact: {
      name: partial.title ?? "",
      externalUrl: partial.externalUrl ?? "",
      organizationId: partial.organizationId ?? "",
      workstreamId: partial.workstreamId ?? null,
      sourceLinks: partial.sourceLinks ?? [],
      targetLinks: partial.targetLinks ?? derivedTargetLinks,
    },
  };
}
