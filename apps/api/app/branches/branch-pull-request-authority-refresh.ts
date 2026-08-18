import { GitHubInstallationStatus, withDb } from "@repo/database";
import type { GitHubSinglePullRequestResult } from "@repo/github/pull-request-rest";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "./pull-request-head-authority";
import { pullRequestLocData } from "./pull-request-loc-data";

/** Atomically settles a guarded branch refresh and its PR-head authority. */
export function settleActiveBranchPullRequestRefresh(input: {
  organizationId: string;
  branchArtifactId: string;
  repositoryId: string;
  pullRequestDetailId: string;
  freshPr: GitHubSinglePullRequestResult;
  now: Date;
}): Promise<boolean> {
  return withDb.tx(async (tx) => {
    const result = await tx.pullRequestDetail.updateMany({
      where: {
        id: input.pullRequestDetailId,
        branchArtifactId: input.branchArtifactId,
        repositoryId: input.repositoryId,
        branchArtifact: { organizationId: input.organizationId },
        repository: {
          removedAt: null,
          installation: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        currentForBranches: {
          some: {
            artifactId: input.branchArtifactId,
            currentPullRequestDetailId: input.pullRequestDetailId,
            artifact: { organizationId: input.organizationId },
            repository: {
              removedAt: null,
              installation: {
                organizationId: input.organizationId,
                status: GitHubInstallationStatus.ACTIVE,
              },
            },
          },
        },
      },
      data: {
        prState: input.freshPr.state,
        githubCreatedAt: input.freshPr.createdAt
          ? new Date(input.freshPr.createdAt)
          : null,
        mergedAt: input.freshPr.mergedAt
          ? new Date(input.freshPr.mergedAt)
          : null,
        closedAt: input.freshPr.closedAt
          ? new Date(input.freshPr.closedAt)
          : null,
        isDraft: input.freshPr.isDraft,
        ...pullRequestLocData(input.freshPr),
        lastVerifiedAt: input.now,
      },
    });
    if (result.count !== 1) {
      return false;
    }
    await persistPullRequestHeadRepositoryAuthority(
      tx,
      {
        organizationId: input.organizationId,
        pullRequestDetailId: input.pullRequestDetailId,
      },
      pullRequestHeadRepositoryObservation(input.freshPr),
      { name: input.freshPr.headBranch, oid: input.freshPr.headSha }
    );
    return true;
  });
}
