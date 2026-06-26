import { GitHubPRState } from "@repo/api/src/types/github";

export const PullRequestLifecycle = {
  Open: "open",
  Draft: "draft",
  Merged: "merged",
  Closed: "closed",
} as const;

export type PullRequestLifecycle =
  (typeof PullRequestLifecycle)[keyof typeof PullRequestLifecycle];

export const PullRequestLifecycleLabels: Record<PullRequestLifecycle, string> =
  {
    [PullRequestLifecycle.Open]: "Open",
    [PullRequestLifecycle.Draft]: "Draft",
    [PullRequestLifecycle.Merged]: "Merged",
    [PullRequestLifecycle.Closed]: "Closed",
  };

type PullRequestLifecycleSource = {
  isDraft?: boolean | null;
  prState?: GitHubPRState | null;
  state?: GitHubPRState | null;
};

/**
 * Derive the user-visible PR lifecycle with terminal states taking precedence
 * over draft, while Draft still replaces the underlying OPEN state.
 */
export function getPullRequestLifecycle(
  pullRequest: PullRequestLifecycleSource | null,
  fallbackState?: string | null
): PullRequestLifecycle | null {
  const state = pullRequest?.state ?? pullRequest?.prState ?? fallbackState;
  switch (state) {
    case GitHubPRState.Merged:
      return PullRequestLifecycle.Merged;
    case GitHubPRState.Closed:
      return PullRequestLifecycle.Closed;
    case GitHubPRState.Open:
      return pullRequest?.isDraft
        ? PullRequestLifecycle.Draft
        : PullRequestLifecycle.Open;
    default:
      return null;
  }
}
