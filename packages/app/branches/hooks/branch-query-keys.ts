const branchQueryRoot = ["branches"] as const;

/** Caller-owned cache identity for organization-scoped Branch HTTP reads. */
export type BranchesQueryIdentity = {
  cacheScope?: string;
};

/** Lightweight canonical prefixes for Branch query families that contain rows. */
export const branchRowQueryKeys = {
  all: branchQueryRoot,
  details: [...branchQueryRoot, "detail"] as const,
  lists: [...branchQueryRoot, "list"] as const,
  pageData: [...branchQueryRoot, "page-data"] as const,
};

/** Exact cache keys for cloud selected-PR files and immutable file diffs. */
export const branchSelectedPullRequestQueryKeys = {
  all: [...branchQueryRoot, "selected-pull-request"] as const,
  files: (
    sourceScope: string,
    identity: BranchesQueryIdentity | undefined,
    branchId: string,
    repositoryFullName: string,
    pullRequestNumber: number
  ) =>
    [
      ...branchSelectedPullRequestQueryKeys.all,
      "files",
      sourceScope,
      branchQueryCacheScope(identity),
      branchId,
      repositoryFullName,
      pullRequestNumber,
    ] as const,
  diff: (
    sourceScope: string,
    identity: BranchesQueryIdentity | undefined,
    branchId: string,
    repositoryFullName: string,
    pullRequestNumber: number,
    path: string,
    baseSha: string,
    headSha: string
  ) =>
    [
      ...branchSelectedPullRequestQueryKeys.all,
      "diff",
      sourceScope,
      branchQueryCacheScope(identity),
      branchId,
      repositoryFullName,
      pullRequestNumber,
      path,
      baseSha,
      headSha,
    ] as const,
};

/** Resolve the cache segment shared by every organization-scoped Branch key. */
export function branchQueryCacheScope(identity?: BranchesQueryIdentity) {
  return identity?.cacheScope ?? "default";
}
