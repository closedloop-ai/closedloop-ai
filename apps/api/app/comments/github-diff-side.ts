import { GitHubDiffSide } from "@repo/database";

/**
 * Normalize GitHub diff-side payloads to the persisted projection contract.
 * GitHub only emits exact LEFT/RIGHT values for supported anchors; all other
 * values are treated as absent anchor metadata.
 */
export function normalizeGitHubDiffSide(
  side: string | null | undefined
): GitHubDiffSide | null {
  if (side === "LEFT") {
    return GitHubDiffSide.LEFT;
  }
  if (side === "RIGHT") {
    return GitHubDiffSide.RIGHT;
  }
  return null;
}
