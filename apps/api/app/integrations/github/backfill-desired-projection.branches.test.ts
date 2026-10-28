import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  GitHubDiffSide,
  GitHubLegacyCommentState,
  ThreadStatus,
} from "@repo/database";
import type {
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
} from "@repo/github";
import { describe, expect, it } from "vitest";
import { pullRequestMetadata } from "@/__tests__/support/integrations/github/backfill-projection-writer.test-fixtures";
import {
  desiredReviewThreadProjection,
  gitHubLegacyStateFromReviewThreadResolved,
  gitHubThreadStatusFromReviewThreadResolved,
  keepLatestReviewPerAuthor,
  reviewThreadIdentity,
} from "./backfill-desired-projection";

/**
 * ISS-11280: direct coverage of the pure mappers the backfill writer and diff
 * counter share. These run over raw GitHub REST payloads, so the malformed
 * shapes below (no thread node id, unknown review state, missing author, an
 * unparseable timestamp) are reachable provider input, not type-forbidden
 * values.
 */

describe("reviewThreadIdentity", () => {
  it("prefers the GraphQL review-thread node id", () => {
    expect(
      reviewThreadIdentity(
        fixtureReviewComment({
          review_thread_node_id: "thread-node-9",
          in_reply_to_id: 77,
        })
      )
    ).toBe("thread-node-9");
  });

  it("falls back to the reply root id when the thread node id is absent", () => {
    expect(
      reviewThreadIdentity(
        fixtureReviewComment({
          review_thread_node_id: null,
          in_reply_to_id: 77,
        })
      )
    ).toBe("77");
  });

  it("falls back to the comment's own id when it is neither threaded nor a reply", () => {
    expect(
      reviewThreadIdentity(
        fixtureReviewComment({
          id: 2002,
          review_thread_node_id: null,
          in_reply_to_id: null,
        })
      )
    ).toBe("2002");
  });
});

describe("desiredReviewThreadProjection", () => {
  it("maps a resolved root comment to the ADDRESSED legacy state", () => {
    expect(desiredReviewThreadProjection(fixtureReviewComment())).toEqual({
      reviewThreadId: "thread-node-2001",
      rootCommentId: "2001",
      reviewId: "3001",
      path: "app.ts",
      line: 10,
      originalLine: 10,
      side: GitHubDiffSide.RIGHT,
      startLine: null,
      startSide: null,
      commitSha: "abc123",
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/42#discussion_r2001",
      legacyState: GitHubLegacyCommentState.ADDRESSED,
    });
  });

  it("roots a reply at its parent and nulls a missing review id and unknown sides", () => {
    const projection = desiredReviewThreadProjection(
      fixtureReviewComment({
        id: 2005,
        in_reply_to_id: 2001,
        review_thread_node_id: null,
        pull_request_review_id: null,
        side: "right",
        start_line: 8,
        start_side: "LEFT",
        review_thread_is_resolved: false,
      })
    );

    expect(projection).toMatchObject({
      reviewThreadId: null,
      rootCommentId: "2001",
      reviewId: null,
      // Only the exact upper-case wire values survive normalization.
      side: null,
      startLine: 8,
      startSide: GitHubDiffSide.LEFT,
      legacyState: GitHubLegacyCommentState.PENDING,
    });
  });

  it("treats a zero review id as absent", () => {
    // pins current behavior; looks odd because the truthiness check drops a
    // numeric id of 0 rather than only null (GitHub never issues id 0).
    expect(
      desiredReviewThreadProjection(
        fixtureReviewComment({ pull_request_review_id: 0 })
      ).reviewId
    ).toBeNull();
  });

  it("leaves legacyState undefined when the provider did not report resolution", () => {
    const projection = desiredReviewThreadProjection(
      fixtureReviewComment({ review_thread_is_resolved: null })
    );

    expect(projection.legacyState).toBeUndefined();
    expect(projection.rootCommentId).toBe("2001");
  });
});

describe("keepLatestReviewPerAuthor", () => {
  it("maps every known review state and keeps one row per author", () => {
    const reviews = [
      fixtureReview({
        id: 1,
        user: { login: "a", avatar_url: "https://a" },
        state: ReviewDecision.Approved,
      }),
      fixtureReview({
        id: 2,
        user: { login: "b", avatar_url: "https://b" },
        state: ReviewDecision.ChangesRequested,
      }),
      fixtureReview({
        id: 3,
        user: { login: "c", avatar_url: "https://c" },
        state: ReviewDecision.Commented,
      }),
      fixtureReview({
        id: 4,
        user: { login: "d", avatar_url: "https://d" },
        state: ReviewDecision.Dismissed,
      }),
    ];

    const latest = keepLatestReviewPerAuthor(reviews);

    expect(
      [...latest.values()].map((review) => [review.authorLogin, review.state])
    ).toEqual([
      ["a", ReviewDecision.Approved],
      ["b", ReviewDecision.ChangesRequested],
      ["c", ReviewDecision.Commented],
      ["d", ReviewDecision.Dismissed],
    ]);
  });

  it("builds the persistable row from the review payload", () => {
    const latest = keepLatestReviewPerAuthor([fixtureReview()]);

    expect(latest.get("reviewer")).toEqual({
      githubReviewId: "3001",
      authorLogin: "reviewer",
      authorAvatarUrl: "https://avatars.githubusercontent.com/u/502",
      state: ReviewDecision.Approved,
      body: "Approved",
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/42#pullrequestreview-3001",
      submittedAt: new Date("2026-07-05T00:04:00.000Z"),
    });
  });

  it("drops reviews with an unknown state, no submission time, or no author", () => {
    const noLogin = fixtureReview({
      id: 13,
      user: { login: "", avatar_url: "https://x" },
    });
    const latest = keepLatestReviewPerAuthor([
      // `PENDING` is a real GitHub review state with no projection mapping.
      fixtureReview({ id: 10, state: "PENDING" }),
      fixtureReview({ id: 11, submitted_at: null }),
      fixtureReview({ id: 12, user: null }),
      noLogin,
    ]);

    expect(latest.size).toBe(0);
  });

  it("stores a null avatar when the provider omits avatar_url", () => {
    const review = fixtureReview();
    if (review.user) {
      // The REST payload is not runtime-validated, so a user object without
      // `avatar_url` reaches this mapper.
      Reflect.deleteProperty(review.user, "avatar_url");
    }

    expect(
      keepLatestReviewPerAuthor([review]).get("reviewer")?.authorAvatarUrl
    ).toBeNull();
  });

  it("keeps the most recently submitted review regardless of payload order", () => {
    const older = fixtureReview({
      id: 20,
      submitted_at: "2026-07-05T00:00:00.000Z",
    });
    const newer = fixtureReview({
      id: 21,
      submitted_at: "2026-07-06T00:00:00.000Z",
    });

    expect(
      keepLatestReviewPerAuthor([newer, older]).get("reviewer")?.githubReviewId
    ).toBe("21");
    expect(
      keepLatestReviewPerAuthor([older, newer]).get("reviewer")?.githubReviewId
    ).toBe("21");
  });

  it("keeps the first review when two share a submission time", () => {
    const first = fixtureReview({ id: 30 });
    const second = fixtureReview({ id: 31 });

    expect(
      keepLatestReviewPerAuthor([first, second]).get("reviewer")?.githubReviewId
    ).toBe("30");
  });

  it("lets an unparseable submission time block every later review", () => {
    const garbled = fixtureReview({ id: 40, submitted_at: "not-a-date" });
    const valid = fixtureReview({
      id: 41,
      submitted_at: "2026-07-06T00:00:00.000Z",
    });

    const kept = keepLatestReviewPerAuthor([garbled, valid]).get("reviewer");

    // pins current behavior; looks odd because an Invalid Date compares false
    // against everything, so the first garbled row is never replaced.
    expect(kept?.githubReviewId).toBe("40");
    expect(Number.isNaN(kept?.submittedAt.getTime())).toBe(true);
  });
});

describe("gitHubLegacyStateFromReviewThreadResolved", () => {
  it("maps resolved to ADDRESSED and unresolved to PENDING", () => {
    expect(gitHubLegacyStateFromReviewThreadResolved(true)).toBe(
      GitHubLegacyCommentState.ADDRESSED
    );
    expect(gitHubLegacyStateFromReviewThreadResolved(false)).toBe(
      GitHubLegacyCommentState.PENDING
    );
  });

  it("returns undefined for null and undefined", () => {
    expect(gitHubLegacyStateFromReviewThreadResolved(null)).toBeUndefined();
    expect(
      gitHubLegacyStateFromReviewThreadResolved(undefined)
    ).toBeUndefined();
  });
});

describe("gitHubThreadStatusFromReviewThreadResolved", () => {
  it("maps resolved to RESOLVED and unresolved to OPEN", () => {
    expect(gitHubThreadStatusFromReviewThreadResolved(true)).toBe(
      ThreadStatus.RESOLVED
    );
    expect(gitHubThreadStatusFromReviewThreadResolved(false)).toBe(
      ThreadStatus.OPEN
    );
  });

  it("returns undefined for null and undefined", () => {
    expect(gitHubThreadStatusFromReviewThreadResolved(null)).toBeUndefined();
    expect(
      gitHubThreadStatusFromReviewThreadResolved(undefined)
    ).toBeUndefined();
  });
});

function fixtureReviewComment(
  over: Partial<GitHubPullRequestReviewComment> = {}
): GitHubPullRequestReviewComment {
  const [comment] = pullRequestMetadata().reviewComments;
  if (!comment) {
    throw new Error("fixture metadata has no review comment");
  }
  return { ...comment, ...over };
}

function fixtureReview(
  over: Partial<GitHubPullRequestReview> = {}
): GitHubPullRequestReview {
  const [review] = pullRequestMetadata().reviews;
  if (!review) {
    throw new Error("fixture metadata has no review");
  }
  return {
    ...review,
    user: review.user ? { ...review.user } : null,
    ...over,
  };
}
