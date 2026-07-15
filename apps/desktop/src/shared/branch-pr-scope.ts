import { LOCAL_REPO_SENTINEL } from "@repo/api/src/types/branch";

/**
 * Returns true when a branch detail route id is scoped to the requested PR repo.
 * Desktop-local branches may carry the `local` repo sentinel; the gateway still
 * performs a later branch-owned PR identity check before provider reads.
 */
export function branchIdMatchesRepo(
  branchId: string,
  owner: string,
  repo: string
): boolean {
  const delimiterIndex = branchId.indexOf("::");
  if (delimiterIndex === -1) {
    return false;
  }
  try {
    const repoFullName = decodeURIComponent(branchId.slice(0, delimiterIndex));
    return (
      repoFullName === `${owner}/${repo}` ||
      repoFullName === LOCAL_REPO_SENTINEL
    );
  } catch {
    return false;
  }
}
