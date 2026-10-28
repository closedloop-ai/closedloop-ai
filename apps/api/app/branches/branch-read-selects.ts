import { LinkType } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { ArtifactType, type Prisma } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import {
  branchTagArtifactsSelect,
  branchTagArtifactsSelectForOrganization,
} from "./branch-tag-projection";

export const BRANCH_REVIEWED_PARTICIPANTS_LIMIT = 100;

/**
 * The branch assignee, which IS the Branch Owner (ISS-12463). The organization
 * id lets the projection scope the Owner to the branch's tenant the way the list
 * SQL's join does, so the two cannot name different people.
 */
const branchAssigneeSelect = {
  select: { ...basicUserSelect.select, organizationId: true },
} as const;

/**
 * The order every branch read hands its PRs to callers in.
 *
 * Exported because it is a CONTRACT, not a formatting choice: the Owner seed's
 * PR-creator rung (`branch-owner-seed-sql.ts`) takes the first PR author it can
 * resolve in this same order (ISS-11752, ISS-12463), so a branch read's PR list
 * and the seed agree on which PR is first.
 */
export const branchPullRequestDetailOrderBy = [
  { repositoryFullName: "asc" },
  { repositoryId: "asc" },
  { number: "asc" },
  { id: "asc" },
] satisfies Prisma.PullRequestDetailOrderByWithRelationInput[];

/** Shared persisted fields for projecting one immutable Branch activity atom. */
export const branchActivityAtomSelect = {
  version: true,
  source: true,
  sourceEventId: true,
  occurredAt: true,
  activityKind: true,
  compatibilityAliasForSourceEventId: true,
  attributionKind: true,
  pullRequestDetailId: true,
  completeness: true,
  createdAt: true,
} satisfies Prisma.BranchActivityAtomSelect;

const branchPullRequestSummarySelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  isCurrent: true,
  // ISS-8153 divergence monitor: the two fields (with the additions/deletions/
  // changedFiles totals below) that let the detail projection run the
  // resolver's own empty-stub test on the maintained pointer.
  fetchMechanism: true,
  githubId: true,
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
  headRefOid: true,
  headRefName: true,
  headRepositoryFullName: true,
  // ISS-11752: the PR author is branch-OWNER evidence, not just detail render
  // data, so every branch read needs it — the list is where an unattributed
  // branch is actually seen. One nullable varchar against a row this wide.
  authorLogin: true,
  repository: {
    select: {
      fullName: true,
      githubRepoId: true,
    },
  },
} satisfies Prisma.PullRequestDetailSelect;

const branchPullRequestDetailSelect = {
  ...branchPullRequestSummarySelect,
  body: true,
  headRefOid: true,
  mergeCommitSha: true,
  lastRefreshAttemptAt: true,
  // ISS-8241: this PR's OWN base ref. Selected here rather than on the summary
  // above because only the one selected PR renders it, so the list reads stay
  // the width they were. `authorLogin` moved UP to the summary in ISS-11752 —
  // it is owner evidence every branch read needs, not selected-PR render data.
  baseRefName: true,
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
  priority: true,
  externalUrl: true,
  createdAt: true,
  projectId: true,
  // ISS-12453: the list needs the project's NAME too, to render the Branches
  // list's Project cell before a user ever opens its picker.
  project: { select: { name: true } },
  assigneeId: true,
  assignee: branchAssigneeSelect,
  _count: { select: { pullRequestDetails: true } },
  tagArtifacts: branchTagArtifactsSelect,
  pullRequestDetails: {
    orderBy: branchPullRequestDetailOrderBy,
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
      // ISS-12309: a deleted Branch is listed and counted everywhere EXCEPT the
      // Active card, which is the one fold that has to see the deletion. Kept in
      // lockstep with `branchAnalyticsSelect`, whose superset relation
      // `asBranchAnalyticsRow` type-checks.
      deletedAt: true,
      headSha: true,
      headShaSource: true,
      headShaObservedAt: true,
      // FEA-4268 (davetho review): the head the file-cache LOC was last refreshed
      // FOR. The `getBranchFileChangeTotals` sums count as the CURRENT head's LOC
      // only when this equals `headSha`; a stale (old-sha) cache that a failed or
      // pending refresh left behind reads as unknown so display/analytics fall back
      // instead of reporting the prior head's size (see `currentFileTotals`).
      fileCacheHeadSha: true,
      fileCacheCapped: true,
      // Explicit set-once push state (PRD-510 FR2) — the FR12 visibility SSOT.
      // Replaces the old headShaSource-derived "remote evidence" gate.
      firstPushedAt: true,
      pushSource: true,
      fileCacheStatus: true,
      fileCacheFileCount: true,
      syncStatus: true,
      lastSyncStartedAt: true,
      lastSyncCompletedAt: true,
      lastSyncErrorCode: true,
      checksStatus: true,
      checksDetailTotalCount: true,
      // ISS-8241 Half A: the head the rollup above was MEASURED at. The detail
      // read serves that rollup as the selected PR's own only while this equals
      // that PR's `headRefOid`; the list keeps reading it as the branch's.
      checksDetailHeadSha: true,
      repository: {
        select: {
          id: true,
          fullName: true,
          githubRepoId: true,
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
    },
  },
} satisfies Prisma.ArtifactSelect;

/**
 * ISS-8241 Half A: the most measured check rows one Branch detail response will
 * carry. One extra row is read past it so a real overflow is REPORTED as
 * truncated rather than silently shortening the list under a full `totalCount`.
 */
export const BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT = 200;

const branchDetailArtifactSelect = {
  ...branchArtifactSelect,
  // ISS-12197: the Artifact row's generic Details-tab fields, DETAIL only.
  slug: true,
  updatedAt: true,
  dueDate: true,
  createdBy: basicUserSelect,
  branch: {
    select: {
      ...branchArtifactSelect.branch.select,
      // ISS-8241 Half A: the rest of the stored current-head checks projection,
      // selected on the DETAIL only — the list states a branch rollup in one
      // word and has no use for the rows behind it.
      checksDetailTruncated: true,
      checksDetailProviderState: true,
      checksDetailUnavailableReason: true,
      checksDetailUpdatedAt: true,
      statusChecks: {
        select: {
          providerKey: true,
          headSha: true,
          kind: true,
          name: true,
          status: true,
          conclusion: true,
          targetUrl: true,
          position: true,
        },
        orderBy: [{ position: "asc" }, { providerKey: "asc" }],
        take: BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT + 1,
      },
    },
  },
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
