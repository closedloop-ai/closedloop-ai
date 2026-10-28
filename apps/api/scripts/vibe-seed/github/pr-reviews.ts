import {
  ReviewDecision,
  type ReviewDecision as ReviewDecisionValue,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { persistLatestGitHubPRReview } from "@/app/integrations/github/pr-review-projection";
import {
  gitHubFetchProvenanceData,
  githubAppWebhookFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";
import {
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "../core/seed-people";
import type { VibeSeedContext } from "../stage";
import type { SeededBranch } from "./seeded-branches";
import type { BranchWork, WorkPullRequest } from "./store-work";

/**
 * ISS-12135: each pull request's reviews, through the writers the GitHub
 * `pull_request_review` webhook calls (`persistLatestGitHubPRReview`, then
 * `recomputeAndUpdateAggregate` for `review_decision`). One to three teammates
 * other than the author review it between opening and settling: a merged pull
 * request merged on approvals, a closed one was turned back, and an open one
 * is still waiting on a requested change.
 */

const HOUR_MS = 60 * 60 * 1000;
const REVIEW_ID_BASE = 3_300_000_000;
const REVIEW_BODIES: Readonly<Record<ReviewDecisionValue, string>> = {
  [ReviewDecision.Approved]: "Looks good to me.",
  [ReviewDecision.ChangesRequested]:
    "Can we cover the empty state before this goes in?",
  [ReviewDecision.Commented]: "Left a couple of small notes.",
  [ReviewDecision.Dismissed]: "",
};

export async function replayPullRequestReviews(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork
): Promise<number> {
  let written = 0;
  for (const pullRequest of work.pullRequests) {
    const detailId = branch.pullRequestIdsByNumber.get(pullRequest.number);
    if (detailId === undefined) {
      continue;
    }
    const reviews = plannedReviews(work, pullRequest, context.now);
    await withDb.tx(async (tx) => {
      for (const review of reviews) {
        await persistLatestGitHubPRReview(tx, {
          pullRequestId: detailId,
          githubReviewId: String(review.id),
          authorLogin: review.login,
          authorAvatarUrl: null,
          state: review.state,
          body: REVIEW_BODIES[review.state],
          htmlUrl: `https://github.com/${branch.repositoryFullName}/pull/${pullRequest.number}#pullrequestreview-${review.id}`,
          submittedAt: review.at,
          ...gitHubFetchProvenanceData(
            githubAppWebhookFetchProvenance(review.at)
          ),
        });
      }
      await recomputeAndUpdateAggregate(tx, detailId);
    });
    written += reviews.length;
  }
  return written;
}

type PlannedReview = {
  readonly id: number;
  readonly login: string;
  readonly state: ReviewDecisionValue;
  readonly at: Date;
};

/** The reviewers, verdicts and times a pull request's review went through. */
export function plannedReviews(
  work: Pick<BranchWork, "author">,
  pullRequest: Pick<WorkPullRequest, "number" | "openedAt" | "facts">,
  now: Date
): PlannedReview[] {
  const reviewers = [VIBE_SEED_SIGNED_IN_PERSON, ...VIBE_SEED_TEAMMATES]
    .map((person) => person.githubUsername)
    .filter((login) => login !== work.author.login);
  const count = 1 + (pullRequest.number % 3);
  const openedMs = pullRequest.openedAt.getTime();
  const settled = pullRequest.facts.mergedAt ?? pullRequest.facts.closedAt;
  const endMs =
    settled === undefined ? now.getTime() : Date.parse(settled) - HOUR_MS;
  const spanMs = Math.max(endMs - openedMs, HOUR_MS);
  return Array.from({ length: count }, (_, index) => ({
    id: REVIEW_ID_BASE + pullRequest.number * 10 + index,
    login:
      reviewers[(pullRequest.number + index) % reviewers.length] ??
      VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
    state: verdict(pullRequest.facts.state, index),
    at: new Date(openedMs + Math.round((spanMs * (index + 1)) / (count + 1))),
  }));
}

function verdict(state: GitHubPRState, index: number): ReviewDecisionValue {
  if (state === GitHubPRState.Merged) {
    return ReviewDecision.Approved;
  }
  if (index === 0) {
    return ReviewDecision.ChangesRequested;
  }
  return state === GitHubPRState.Closed
    ? ReviewDecision.Commented
    : ReviewDecision.Approved;
}
