import type { VibeSeedContext } from "../stage";

/** A branch of the vibe org as the GitHub stages need it. */
export type SeededBranch = {
  readonly artifactId: string;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  /** The installation repository's GitHub id, when the branch has one. */
  readonly repositoryGitHubId: number | null;
  readonly repositoryFullName: string;
  readonly branchName: string;
  readonly currentPullRequestDetailId: string | null;
  readonly pullRequestIdsByNumber: ReadonlyMap<number, string>;
};

/** Every live branch of the org, with the pull requests filed under it. */
export async function readSeededBranches(
  context: VibeSeedContext
): Promise<SeededBranch[]> {
  const branches = await context.prisma.branchDetail.findMany({
    where: { organizationId: context.organizationId, deletedAt: null },
    orderBy: [{ repositoryFullName: "asc" }, { branchName: "asc" }],
    select: {
      artifactId: true,
      repositoryId: true,
      repositoryFullName: true,
      branchName: true,
      currentPullRequestDetailId: true,
      artifact: { select: { projectId: true } },
      repository: { select: { githubRepoId: true } },
    },
  });
  const pullRequests = await context.prisma.pullRequestDetail.findMany({
    where: {
      organizationId: context.organizationId,
      branchArtifactId: { in: branches.map((branch) => branch.artifactId) },
    },
    select: { id: true, number: true, branchArtifactId: true },
  });
  return branches.map((branch) => ({
    artifactId: branch.artifactId,
    projectId: branch.artifact.projectId,
    repositoryId: branch.repositoryId,
    repositoryGitHubId: gitHubRepositoryId(branch.repository?.githubRepoId),
    repositoryFullName: branch.repositoryFullName,
    branchName: branch.branchName,
    currentPullRequestDetailId: branch.currentPullRequestDetailId,
    pullRequestIdsByNumber: new Map(
      pullRequests
        .filter((pr) => pr.branchArtifactId === branch.artifactId)
        .map((pr) => [pr.number, pr.id])
    ),
  }));
}

function gitHubRepositoryId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
