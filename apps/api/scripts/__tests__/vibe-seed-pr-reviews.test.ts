/**
 * ISS-12135: who reviews each seeded pull request, with what verdict, and when.
 */
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { describe, expect, it } from "vitest";
import { plannedReviews } from "../vibe-seed/github/pr-reviews";
import { gitHubPerson } from "../vibe-seed/github/store-work";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const OPENED_AT = new Date("2026-10-01T09:00:00.000Z");
const MERGED_AT = "2026-10-03T12:00:00.000Z";
const AUTHOR = gitHubPerson("dreyes");
const BASE_FACTS = {
  title: "Shared sync order",
  isDraft: false,
  baseRef: "main",
};

describe("plannedReviews", () => {
  it("approves a merged pull request by teammates other than its author, between opening and merge", () => {
    for (const number of [4924, 4925, 4926]) {
      const reviews = plannedReviews(
        { author: AUTHOR },
        {
          number,
          openedAt: OPENED_AT,
          facts: {
            ...BASE_FACTS,
            state: GitHubPRState.Merged,
            mergedAt: MERGED_AT,
            closedAt: MERGED_AT,
          },
        },
        NOW
      );
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews.length).toBeLessThanOrEqual(3);
      for (const review of reviews) {
        expect(review.state).toBe(ReviewDecision.Approved);
        expect(review.login).not.toBe(AUTHOR.login);
        expect(review.at.getTime()).toBeGreaterThan(OPENED_AT.getTime());
        expect(review.at.getTime()).toBeLessThan(Date.parse(MERGED_AT));
      }
      expect(new Set(reviews.map((review) => review.login)).size).toBe(
        reviews.length
      );
    }
  });

  it("leaves an open pull request waiting on a requested change", () => {
    const [first] = plannedReviews(
      { author: AUTHOR },
      {
        number: 5601,
        openedAt: OPENED_AT,
        facts: { ...BASE_FACTS, state: GitHubPRState.Open },
      },
      NOW
    );
    expect(first?.state).toBe(ReviewDecision.ChangesRequested);
    expect(first?.at.getTime()).toBeLessThan(NOW.getTime());
  });
});
