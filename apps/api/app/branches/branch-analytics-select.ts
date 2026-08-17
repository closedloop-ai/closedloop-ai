import type { Prisma } from "@repo/database";
import { branchActivityAtomSelect } from "./branch-read-selects";

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
  additions: true,
  deletions: true,
  repository: { select: { fullName: true } },
} satisfies Prisma.PullRequestDetailSelect;

/** Narrow persisted projection used by cohort and list analytics. */
export const branchAnalyticsSelect = {
  id: true,
  status: true,
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
      repositoryId: true,
      repositoryFullName: true,
      repository: { select: { fullName: true } },
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
      headSha: true,
      fileCacheStatus: true,
      fileCacheHeadSha: true,
      fileCacheFileCount: true,
      fileChanges: {
        select: { additions: true, deletions: true },
        take: 500,
      },
    },
  },
} satisfies Prisma.ArtifactSelect;

export type SelectedBranchAnalyticsArtifact = Prisma.ArtifactGetPayload<{
  select: typeof branchAnalyticsSelect;
}>;

export type BranchAnalyticsArtifactRow = SelectedBranchAnalyticsArtifact & {
  branch: NonNullable<SelectedBranchAnalyticsArtifact["branch"]>;
};

/** Narrow a persisted analytics row to one with its required branch relation. */
export function hasBranchAnalyticsRow(
  row: SelectedBranchAnalyticsArtifact | null
): row is BranchAnalyticsArtifactRow {
  return Boolean(row?.branch);
}
