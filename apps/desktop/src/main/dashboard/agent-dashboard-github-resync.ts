import { parseGitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope";
import type { GitHubResyncNudgeBody } from "@repo/api/src/types/github-dirty-scope-constants";

export type GitHubResyncNudgeRefreshResult = {
  body: GitHubResyncNudgeBody;
  branchIds: string[];
};

/**
 * Acknowledge a GitHub resync nudge. Desktop fetches no GitHub data from the
 * cloud, so there is nothing to refresh and no branch is named; the cloud still
 * sends the command to every installed build, so it stays accepted.
 */
export function refreshGitHubResyncBranches(
  body: unknown
): Promise<GitHubResyncNudgeRefreshResult> {
  return Promise.resolve({
    body: parseGitHubResyncNudgeBody(body).body,
    branchIds: [],
  });
}
