import { type BranchRow, encodeBranchId } from "@repo/api/src/types/branch";
import {
  type GitHubDirtyScope,
  GitHubDirtyScopeKind,
} from "@repo/api/src/types/github-dirty-scope-constants";

/** Resolve dirty GitHub scopes to branch cache ids when the local branch list has enough identity. */
export function resolveGitHubResyncBranchIds(
  scopes: readonly GitHubDirtyScope[],
  rows: readonly BranchRow[]
): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    if (scope.kind === GitHubDirtyScopeKind.Generic) {
      continue;
    }
    const id = resolveScopeBranchId(scope, rows);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

function resolveScopeBranchId(
  scope: GitHubDirtyScope,
  rows: readonly BranchRow[]
): string | null {
  if (scope.repositoryFullName && scope.branchName) {
    const encodedId = encodeBranchId({
      repoFullName: scope.repositoryFullName,
      branchName: scope.branchName,
    });
    if (rows.some((row) => row.id === encodedId)) {
      return encodedId;
    }
    return (
      rows.find(
        (row) =>
          row.repoFullName === scope.repositoryFullName &&
          row.branchName === scope.branchName
      )?.id ?? null
    );
  }

  if (scope.repositoryFullName && scope.pullRequestNumber) {
    return (
      rows.find(
        (row) =>
          row.repoFullName === scope.repositoryFullName &&
          row.prNumber === scope.pullRequestNumber
      )?.id ?? null
    );
  }

  return null;
}
