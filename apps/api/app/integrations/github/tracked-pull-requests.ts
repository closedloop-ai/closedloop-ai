import type { GetPullRequestsResponse } from "@repo/api/src/types/github";
import { ArtifactType, withDb } from "@repo/database";
import { parseGitHubPullRequestUrl } from "@/app/artifact-links/pull-requests/pull-request-url";

/**
 * Resolve which PRs/branches a project already tracks as ExternalLinks, so the
 * repository pull-requests read can mark them and target their PR numbers. Split
 * out of the github service (PLN-1535) — it is consumed only by getPullRequests.
 */
export async function getTrackedPullRequestState(input: {
  organizationId: string;
  projectId: string | null;
  repositoryFullName: string;
  repositoryId: string;
}): Promise<{
  trackedPrUrls: string[];
  trackedBranches: NonNullable<GetPullRequestsResponse["trackedBranches"]>;
  trackedBranchKeys: string[];
  trackedPrNumbers: number[];
}> {
  if (!input.projectId) {
    return {
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
    };
  }

  const existingBranches = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.BRANCH,
        branch: { repositoryId: input.repositoryId },
      },
      select: {
        externalUrl: true,
        branch: {
          select: {
            branchName: true,
            currentPullRequestDetail: {
              select: { htmlUrl: true },
            },
          },
        },
      },
    })
  );

  const trackedBranches = existingBranches.flatMap((artifact) => {
    if (!artifact.branch) {
      return [];
    }
    const branchKey = `${input.repositoryFullName}:${artifact.branch.branchName}`;
    return [
      {
        branchName: artifact.branch.branchName,
        branchKey,
        htmlUrl: artifact.externalUrl ?? "",
        pullRequestUrl:
          artifact.branch.currentPullRequestDetail?.htmlUrl ?? null,
      },
    ];
  });
  const trackedPrUrls = trackedBranches.flatMap((branch) =>
    branch.pullRequestUrl ? [branch.pullRequestUrl] : []
  );
  return {
    trackedPrUrls,
    trackedBranches,
    trackedBranchKeys: trackedBranches.map((branch) => branch.branchKey),
    trackedPrNumbers: extractTrackedPullRequestNumbers(
      input.repositoryFullName,
      trackedPrUrls
    ),
  };
}

function extractTrackedPullRequestNumbers(
  repositoryFullName: string,
  trackedPrUrls: readonly string[]
): number[] {
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const url of trackedPrUrls) {
    const parsed = parseGitHubPullRequestUrl(url);
    if (parsed?.fullName !== repositoryFullName || seen.has(parsed.number)) {
      continue;
    }
    seen.add(parsed.number);
    numbers.push(parsed.number);
  }
  return numbers;
}
