const LAST_SEGMENT_RE = /\/[^/]+$/;

/**
 * Construct worktree path from base repo path and ticket ID.
 *
 * @param worktreeParentDir - The configured worktree parent directory.
 *   When provided, the worktree is resolved as `{worktreeParentDir}/{repoName}-{ticketId}`.
 *   When omitted, falls back to assuming the worktree is a sibling of the repo (legacy behavior).
 */
export function getWorktreePath(
  baseRepoPath: string,
  ticketId: string,
  worktreeParentDir?: string
): string {
  const repoName = baseRepoPath.split("/").pop() || "";
  if (worktreeParentDir) {
    const dir = worktreeParentDir.endsWith("/")
      ? worktreeParentDir.slice(0, -1)
      : worktreeParentDir;
    return `${dir}/${repoName}-${ticketId}`;
  }
  const sourceDir = baseRepoPath.replace(LAST_SEGMENT_RE, "");
  return `${sourceDir}/${repoName}-${ticketId}`;
}
