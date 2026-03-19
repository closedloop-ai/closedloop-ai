/**
 * Derive the base repo path from a worktree directory path.
 * Handles both ticket-based ({repoName}-{ticketId}) and
 * loop-based ({repoName}-loop-{slug}) naming schemes.
 */
export function deriveBaseRepoPath(
  worktreePath: string,
  ticketIdentifier: string
): string {
  const pathParts = worktreePath.split("/");
  const worktreeDirName = pathParts.at(-1)!;
  const parentDir = pathParts.slice(0, -1).join("/");

  // Try ticket-based suffix first (more specific, avoids false matches
  // on repos whose name contains "-loop-").
  const sanitizedTicket = ticketIdentifier.replaceAll(/[^a-zA-Z0-9-_]/g, "_");
  const ticketSuffix = `-${sanitizedTicket}`;
  if (worktreeDirName.endsWith(ticketSuffix)) {
    return `${parentDir}/${worktreeDirName.slice(0, -ticketSuffix.length)}`;
  }

  // Fall back to loop-style suffix: <repoName>-loop-<slug>
  const loopSuffixMatch = /^(.+)-loop-.+$/.exec(worktreeDirName);
  if (loopSuffixMatch) {
    return `${parentDir}/${loopSuffixMatch[1]}`;
  }

  // Neither matched -- return dirname as-is (best effort)
  return `${parentDir}/${worktreeDirName}`;
}
