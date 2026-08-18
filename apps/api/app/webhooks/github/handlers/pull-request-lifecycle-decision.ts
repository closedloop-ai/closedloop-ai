import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubPRState } from "@repo/api/src/types/github";

/**
 * Pure lifecycle-decision helpers for the pull_request webhook handler.
 *
 * Split out of `pull-request-handler.ts` (which is a large, grandfathered file)
 * because these are self-contained, side-effect-free predicates over a PR's
 * persisted state versus an incoming webhook payload — a distinct responsibility
 * from the handler's persistence orchestration. Kept side-effect-free so they
 * stay unit-testable without a transaction client.
 */

/** The subset of a persisted PR's fields these predicates read. */
export type LifecyclePrState = {
  currentPullRequestDetailId: string | null;
  pullRequestDetailId: string | null;
  prState: GitHubPRState | null;
  isDraft: boolean | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  headSha: string | null;
  hasBranchArtifact: boolean;
};

export type LifecycleDecision =
  | { apply: true }
  | { apply: false; reason: string };

/**
 * Map a GitHub webhook `pull_request` payload to our `GitHubPRState`. A closed
 * PR is `Merged` when it was merged, otherwise `Closed`; anything else is
 * `Open`.
 */
export function pullRequestState(pullRequest: PullRequest): GitHubPRState {
  if (pullRequest.state === "closed") {
    return pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
  }
  return GitHubPRState.Open;
}

/**
 * A current-branch PR event applies unless a NEWER PR detail already owns the
 * branch: when the branch artifact's current PR detail differs from the one
 * this event is about, the event is stale and must not overwrite branch state.
 */
export function shouldApplyCurrentBranchPrEvent(
  existingPr: LifecyclePrState
): boolean {
  if (!existingPr.hasBranchArtifact) {
    return true;
  }
  if (
    !(existingPr.currentPullRequestDetailId && existingPr.pullRequestDetailId)
  ) {
    return true;
  }
  return (
    existingPr.currentPullRequestDetailId === existingPr.pullRequestDetailId
  );
}

/**
 * Protect current PR lifecycle state from duplicate webhook delivery and
 * stale open-ish events. GitHub webhooks are at-least-once; the DB row remains
 * authoritative when a terminal merge or newer close is already persisted.
 */
export function shouldApplyPullRequestLifecycleUpdate(
  current: LifecyclePrState | null,
  incoming: PullRequest,
  action: string
): LifecycleDecision {
  if (!current) {
    return { apply: true };
  }

  const incomingState = pullRequestState(incoming);
  if (
    action !== "edited" &&
    action !== "synchronize" &&
    current.prState === incomingState &&
    current.isDraft === (incoming.draft ?? false) &&
    current.headSha === incoming.head.sha
  ) {
    return { apply: false, reason: "duplicate" };
  }
  if (current.prState === GitHubPRState.Merged) {
    return { apply: false, reason: "merged_terminal" };
  }

  const terminalObservedAt = current.mergedAt ?? current.closedAt;
  const incomingUpdatedAt = new Date(incoming.updated_at);
  const opensLifecycle =
    action === "opened" ||
    action === "edited" ||
    action === "synchronize" ||
    action === "converted_to_draft" ||
    action === "ready_for_review" ||
    action === "reopened";
  if (
    terminalObservedAt &&
    opensLifecycle &&
    incomingUpdatedAt.getTime() <= terminalObservedAt.getTime()
  ) {
    return { apply: false, reason: "stale_open_event" };
  }

  if (
    current.prState === GitHubPRState.Closed &&
    action !== "reopened" &&
    opensLifecycle
  ) {
    return { apply: false, reason: "closed_terminal_for_action" };
  }

  return { apply: true };
}
