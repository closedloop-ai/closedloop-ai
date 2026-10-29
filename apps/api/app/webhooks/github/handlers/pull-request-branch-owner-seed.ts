import type { TransactionClient } from "@repo/database";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { needsGitHubHeadRefile } from "@/app/branches/pull-request-github-head-filing";

/**
 * ISS-12463: seed the assignee of the Branch this PR is filed under once the
 * delivery has written its creator, including after a relink moved it. The
 * seed's first stamp is final, so a PR the delivery's head still shows misfiled
 * (its head Branch not created yet) stamps nothing; the refile that moves it
 * seeds the head Branch. The org is the Branch's own.
 */
export async function seedPullRequestBranchOwner(
  tx: TransactionClient,
  repository: { id: string; fullName: string },
  pullRequest: {
    number: number;
    head: { ref: string; repo: { full_name: string } | null };
  }
): Promise<void> {
  const filed = await tx.pullRequestDetail.findUnique({
    where: {
      repositoryId_number: {
        repositoryId: repository.id,
        number: pullRequest.number,
      },
    },
    select: {
      branchArtifactId: true,
      branchArtifact: {
        select: {
          organizationId: true,
          branch: { select: { branchName: true, repositoryFullName: true } },
        },
      },
    },
  });
  if (!(filed?.branchArtifactId && filed.branchArtifact)) {
    return;
  }
  const misfiled = needsGitHubHeadRefile(
    {
      repositoryFullName: repository.fullName,
      branch: filed.branchArtifact.branch,
    },
    {
      branchName: pullRequest.head.ref,
      repositoryFullName: pullRequest.head.repo?.full_name,
      updatedAt: null,
    }
  );
  if (!misfiled) {
    await seedBranchOwners(tx, filed.branchArtifact.organizationId, [
      filed.branchArtifactId,
    ]);
  }
}
