import type { Prisma } from "@repo/database";
import type { CanonicalCloudBranchActivityAtom } from "./branch-activity-canonical-read";
import type { BranchFileChangeTotals } from "./branch-read-service/file-change-totals-read";

const branchAnalyticsPullRequestDetailSelect = {
  id: true,
  branchArtifactId: true,
  repositoryId: true,
  repositoryFullName: true,
  number: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  reviewDecision: true,
  githubCreatedAt: true,
  closedAt: true,
  mergedAt: true,
  lastVerifiedAt: true,
  // ISS-11589: the authority arm of the merged-PR twin tie-break. Only the
  // App/webhook path writes a githubId, so a row without one cannot settle a
  // size disagreement against a row that has one.
  githubId: true,
  additions: true,
  deletions: true,
  // ISS-8422: part of the observation evidence set, so the analytics lane must
  // read it too — a PR whose only observed fact was `changed_files` would
  // otherwise be observed to the list and factless to the KPIs.
  changedFiles: true,
  headRefOid: true,
  headRefName: true,
  headRepositoryFullName: true,
  repository: { select: { fullName: true, githubRepoId: true } },
} satisfies Prisma.PullRequestDetailSelect;

/** Narrow persisted projection used by cohort and list analytics. */
export const branchAnalyticsSelect = {
  id: true,
  status: true,
  projectId: true,
  _count: { select: { pullRequestDetails: true } },
  pullRequestDetails: {
    orderBy: [
      { repositoryFullName: "asc" },
      { repositoryId: "asc" },
      { number: "asc" },
      { id: "asc" },
    ],
    select: branchAnalyticsPullRequestDetailSelect,
  },
  branch: {
    select: {
      // ISS-12309: a deleted Branch is listed and counted everywhere EXCEPT the
      // Active card, which is the one fold that has to see the deletion.
      deletedAt: true,
      repositoryId: true,
      repositoryFullName: true,
      repository: { select: { fullName: true, githubRepoId: true } },
      firstPushedAt: true,
      pushSource: true,
      headSha: true,
      headShaSource: true,
      headShaObservedAt: true,
      branchName: true,
      fileCacheStatus: true,
      fileCacheHeadSha: true,
      fileCacheCapped: true,
      fileCacheFileCount: true,
    },
  },
} satisfies Prisma.ArtifactSelect;

export type SelectedBranchAnalyticsArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchAnalyticsSelect;
}>;

/** A selected analytics row proven to carry its branch relation, pre-hydration. */
export type BranchAnalyticsArtifactRowWithBranch =
  SelectedBranchAnalyticsArtifact & {
    branch: NonNullable<SelectedBranchAnalyticsArtifact["branch"]>;
  };

/**
 * ISS-8016: the row as CONSUMERS see it. `activityAtoms` is no longer fetched by
 * the select — `applyBranchCandidateActivitySnapshot` is its only source — so it
 * is promised here rather than inherited from the Prisma payload.
 *
 * ISS-10298: `fileChangeTotals` arrives the same way, from
 * `getBranchFileChangeTotals`. The select no longer loads the per-file rows
 * either, because `currentFileTotals` only ever read three numbers out of them.
 */
export type BranchAnalyticsArtifactRow =
  BranchAnalyticsArtifactRowWithBranch & {
    branch: BranchAnalyticsArtifactRowWithBranch["branch"] & {
      activityAtoms: CanonicalCloudBranchActivityAtom[];
      fileChangeTotals: BranchFileChangeTotals;
    };
  };

/** Narrow a persisted analytics row to one with its required branch relation. */
export function hasBranchAnalyticsRow(
  row: SelectedBranchAnalyticsArtifact | null
): row is BranchAnalyticsArtifactRowWithBranch {
  return Boolean(row?.branch);
}
