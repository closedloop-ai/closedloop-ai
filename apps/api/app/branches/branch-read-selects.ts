import { LinkType } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { ArtifactType, type Prisma } from "@repo/database";
import {
  branchTagArtifactsSelect,
  branchTagArtifactsSelectForOrganization,
} from "./branch-tag-projection";

export const BRANCH_REVIEWED_PARTICIPANTS_LIMIT = 100;

/** Shared persisted fields for projecting one immutable Branch activity atom. */
export const branchActivityAtomSelect = {
  version: true,
  source: true,
  sourceEventId: true,
  occurredAt: true,
  attributionKind: true,
  pullRequestDetailId: true,
  completeness: true,
} satisfies Prisma.BranchActivityAtomSelect;

const branchPullRequestSummarySelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  isCurrent: true,
  number: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  additions: true,
  deletions: true,
  changedFiles: true,
  reviewDecision: true,
  // FEA-3552: GitHub PR createdAt — anchors the rail's distinct "PR opened" dot.
  githubCreatedAt: true,
  closedAt: true,
  mergedAt: true,
  lastVerifiedAt: true,
  lastRefreshAttemptAt: true,
  repository: {
    select: {
      fullName: true,
    },
  },
} satisfies Prisma.PullRequestDetailSelect;

const branchPullRequestDetailSelect = {
  ...branchPullRequestSummarySelect,
  body: true,
  headRefOid: true,
  mergeCommitSha: true,
  lastRefreshAttemptAt: true,
} satisfies Prisma.PullRequestDetailSelect;

const branchPullRequestReviewSelect = {
  githubReviewId: true,
  authorLogin: true,
  authorAvatarUrl: true,
  state: true,
  htmlUrl: true,
  submittedAt: true,
} satisfies Prisma.GitHubPRReviewSelect;

const branchPullRequestDetailWithReviewsSelect = {
  ...branchPullRequestDetailSelect,
  reviews: {
    where: { state: { not: ReviewDecision.Dismissed } },
    orderBy: [{ submittedAt: "desc" }, { authorLogin: "asc" }, { id: "asc" }],
    select: branchPullRequestReviewSelect,
    take: BRANCH_REVIEWED_PARTICIPANTS_LIMIT + 1,
  },
} satisfies Prisma.PullRequestDetailSelect;

const branchArtifactSelect = {
  id: true,
  // Top-level Artifact.organizationId — the org SSOT (PRD-510 FR13). Selected so
  // the by-id branch reads can run resolveOrgScope() against the SSOT itself, not
  // just the denormalized BranchDetail copy.
  organizationId: true,
  name: true,
  status: true,
  externalUrl: true,
  createdAt: true,
  projectId: true,
  tagArtifacts: branchTagArtifactsSelect,
  pullRequestDetails: {
    orderBy: [
      { repositoryFullName: "asc" },
      { repositoryId: "asc" },
      { number: "asc" },
      { id: "asc" },
    ],
    select: branchPullRequestSummarySelect,
  },
  branch: {
    select: {
      artifactId: true,
      repositoryId: true,
      // D2 branch identity (PRD-510): the producer-independent normalized
      // `owner/name`, populated for every branch incl. non-App ones with no
      // installation-repo row. Surfaced as `repoFullName` when `repository` is
      // absent so non-App rows keep a repo identity in the list/detail DTO.
      repositoryFullName: true,
      branchName: true,
      baseBranch: true,
      headSha: true,
      // FEA-4268 (shafty023 review): the head the file-cache LOC was last refreshed
      // FOR. `sumFileChanges` totals count as the CURRENT head's LOC only when this
      // equals `headSha`; a stale (old-sha) cache that a failed/pending refresh left
      // behind reads as unknown so display/analytics fall back instead of reporting
      // the prior head's size (see `currentFileTotals`).
      fileCacheHeadSha: true,
      // Explicit set-once push state (PRD-510 FR2) — the FR12 visibility SSOT.
      // Replaces the old headShaSource-derived "remote evidence" gate.
      firstPushedAt: true,
      activityAtoms: {
        orderBy: [
          { occurredAt: "desc" },
          { source: "asc" },
          { sourceEventId: "asc" },
        ],
        select: branchActivityAtomSelect,
        take: 1,
      },
      syncStatus: true,
      lastSyncStartedAt: true,
      lastSyncCompletedAt: true,
      lastSyncErrorCode: true,
      checksStatus: true,
      checksDetailTotalCount: true,
      currentPullRequestDetailId: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          name: true,
          owner: true,
          removedAt: true,
          installation: {
            select: {
              organizationId: true,
              installationId: true,
              status: true,
            },
          },
        },
      },
      currentPullRequestDetail: {
        select: branchPullRequestSummarySelect,
      },
      fileChanges: {
        select: {
          additions: true,
          deletions: true,
          path: true,
        },
        take: 500,
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

const branchDetailArtifactSelect = {
  ...branchArtifactSelect,
  targetLinks: {
    where: {
      linkType: LinkType.Produces,
      source: { type: ArtifactType.DOCUMENT },
    },
    orderBy: [{ createdAt: "asc" }, { sourceId: "asc" }],
    select: {
      id: true,
      createdAt: true,
      source: {
        select: {
          id: true,
          type: true,
          subtype: true,
          name: true,
          slug: true,
          externalUrl: true,
        },
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

/** Select the cloud Branch list payload with generic tags scoped at the join. */
export function branchArtifactSelectForOrganization(organizationId: string) {
  return {
    ...branchArtifactSelect,
    tagArtifacts: branchTagArtifactsSelectForOrganization(organizationId),
  } satisfies Prisma.ArtifactSelect;
}

/** Select the cloud Branch detail payload with generic tags scoped at the join. */
export function branchDetailArtifactSelectForOrganization(
  organizationId: string
) {
  return {
    ...branchDetailArtifactSelect,
    tagArtifacts: branchTagArtifactsSelectForOrganization(organizationId),
    targetLinks: {
      ...branchDetailArtifactSelect.targetLinks,
      where: {
        ...branchDetailArtifactSelect.targetLinks.where,
        organizationId,
        source: { organizationId, type: ArtifactType.DOCUMENT },
      },
    },
  } satisfies Prisma.ArtifactSelect;
}

export type SelectedBranchArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchArtifactSelect;
}>;

export type SelectedBranchDetailArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchDetailArtifactSelect;
}>;

/** Heavy fields loaded only after the shared selector chooses one PR. */
export type SelectedBranchPullRequestDetail =
  Prisma.PullRequestDetailGetPayload<{
    select: typeof branchPullRequestDetailWithReviewsSelect;
  }>;

/** Select body/reviews for the one selected associated pull request. */
export const selectedBranchPullRequestDetailSelect =
  branchPullRequestDetailWithReviewsSelect;
