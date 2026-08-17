import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";

/**
 * ISS-4760: the SINGLE definition of "which artifact's tags become a pull
 * request's GitHub labels".
 *
 * Two paths converge a PR's labels — the `pull_request` webhook and the
 * post-tag-mutation reconciliation — and before this module each derived the
 * source its own way. The webhook read the produces-link OWNER, while the
 * link-PR dialog sends the implementing ISSUE as the tag source and the PLAN as
 * the link owner (`tagSourceArtifactId` vs `linkSourceArtifactId` in
 * `select-pr-dialog.tsx`). On the common issue-with-plan flow that meant the
 * dialog labelled a PR from the issue's tags and the webhook then relabelled it
 * from the plan's — two paths, two answers, for one PR.
 *
 * The identity is DERIVED rather than persisted so it holds for rows written
 * before ISS-4759 too: a link owned by an IMPLEMENTATION_PLAN resolves to the
 * DOCUMENT that produces that plan (the issue/feature), and every other owner
 * is its own label source. That reproduces the dialog's `documentId ?? planId`
 * exactly, for both the plan-owned and the issue-owned flow.
 */

/**
 * Prisma `select` for the artifact side of a PR/branch link: its project, the
 * oldest DOCUMENT that produces it, and — because the owner may be a plan —
 * that owner's own producing DOCUMENT one hop further up.
 *
 * One hop only. `PRD -produces-> Feature -produces-> Plan` is a real lineage,
 * so walking further would resolve a plan-owned link all the way to the PRD and
 * label the PR from the wrong document.
 */
export const PULL_REQUEST_LABEL_SOURCE_SELECT = {
  projectId: true,
  targetLinks: {
    where: {
      linkType: LinkType.Produces,
      source: { type: ArtifactType.Document },
    },
    select: {
      sourceId: true,
      source: {
        select: {
          subtype: true,
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.Document },
            },
            select: { sourceId: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 1,
  },
} as const;

/** The shape `PULL_REQUEST_LABEL_SOURCE_SELECT` produces on one linked side. */
export type PullRequestLabelSourceRow = {
  projectId: string | null;
  targetLinks: {
    sourceId: string;
    source: {
      subtype: string | null;
      targetLinks: { sourceId: string }[];
    } | null;
  }[];
};

export type ResolvedPullRequestLabelSource = {
  /** The project the linked branch/PR artifact belongs to. */
  projectId: string;
  /** The artifact whose tags are this pull request's labels. */
  artifactId: string;
  /** The artifact that owns the PRODUCES link (the plan, on a plan flow). */
  linkOwnerArtifactId: string;
};

/**
 * Resolve the label source from the two link shapes a PR-detail row can carry.
 *
 * Branch-owned linkage wins; the legacy PR-owned `artifact` relation is the
 * fallback for rows that predate the branch-first model. The project is read
 * from the SAME side as the link so a fallback cannot mix one artifact's link
 * with another's project scope.
 *
 * Returns `null` when neither side carries a producing document — an unlinked
 * PR simply has no tags to propagate.
 */
export function resolvePullRequestLabelSource(detail: {
  artifact?: PullRequestLabelSourceRow | null;
  branchArtifact?: PullRequestLabelSourceRow | null;
}): ResolvedPullRequestLabelSource | null {
  const linked = detail.branchArtifact?.targetLinks[0]
    ? detail.branchArtifact
    : detail.artifact;
  const link = linked?.targetLinks[0];
  const projectId = linked?.projectId ?? null;
  if (!(link && projectId)) {
    return null;
  }
  return {
    projectId,
    artifactId: labelSourceFromLinkOwner(link),
    linkOwnerArtifactId: link.sourceId,
  };
}

/**
 * A plan-owned link resolves to the document that produces the plan; every
 * other owner is its own label source. A plan with no producing document (a
 * standalone plan) falls back to itself rather than resolving to nothing.
 */
function labelSourceFromLinkOwner(link: {
  sourceId: string;
  source: {
    subtype: string | null;
    targetLinks: { sourceId: string }[];
  } | null;
}): string {
  if (link.source?.subtype !== ArtifactSubtype.ImplementationPlan) {
    return link.sourceId;
  }
  return link.source.targetLinks[0]?.sourceId ?? link.sourceId;
}
