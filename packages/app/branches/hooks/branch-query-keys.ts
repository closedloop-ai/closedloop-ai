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
  /** ISS-12278: the selected PR's live checks, pinned to the head the detail rendered. */
  checks: (
    sourceScope: string,
    identity: BranchesQueryIdentity | undefined,
    branchId: string,
    repositoryFullName: string,
    pullRequestNumber: number,
    headSha: string
  ) =>
    [
      ...branchSelectedPullRequestQueryKeys.all,
      "checks",
      sourceScope,
      branchQueryCacheScope(identity),
      branchId,
      repositoryFullName,
      pullRequestNumber,
      headSha,
    ] as const,
};

/**
 * ISS-10980: the exact key for one branch's Activity feed, nested under
 * `details` so a detail-scoped invalidation reaches it. Source scope leads the
 * branch id for the same reason every other Branch key carries it: a surface
 * that swaps sources must never serve one source's rows from another's cache.
 * The identity segment follows it, as on the detail and trace keys, so an
 * account switch that re-namespaces the Branch client leaves the previous
 * account's pages unreachable (PR #8601 review).
 */
export function branchActivityQueryKey(
  sourceScope: string,
  identity: BranchesQueryIdentity | undefined,
  branchId: string
) {
  return [
    ...branchRowQueryKeys.details,
    sourceScope,
    branchQueryCacheScope(identity),
    branchId,
    "activity",
  ] as const;
}

/** Resolve the cache segment shared by every organization-scoped Branch key. */
export function branchQueryCacheScope(identity?: BranchesQueryIdentity) {
  return identity?.cacheScope ?? "default";
}
