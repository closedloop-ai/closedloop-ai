import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
/** Return the distinct non-empty provider head branches in encounter order. */
export function collectHeadBranches(
  pullRequests: readonly GitHubReadModelPullRequest[]
): string[] {
  return [
    ...new Set(
      pullRequests
        .map((pullRequest) => pullRequest.headBranch)
        .filter((branchName) => branchName.length > 0)
    ),
  ];
}

/** Convert an optional provider timestamp for Prisma writes without inventing one. */
export function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
