import {
  type BranchViewComment,
  CommentKind,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { describe, expect, it } from "vitest";
import {
  getReplyTargetGithubCommentId,
  isResolvableReviewComment,
  isResolvedComment,
} from "../comment-resolution";

function makeComment(overrides: Partial<BranchViewComment>): BranchViewComment {
  return {
    id: "c_1",
    githubCommentId: "1",
    author: "octocat",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.User,
    body: "body",
    createdAt: "2026-01-01T00:00:00Z",
    path: null,
    line: null,
    state: PRReviewCommentState.Pending,
    reviewId: null,
    htmlUrl: "",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    ...overrides,
  } satisfies BranchViewComment;
}

describe("isResolvableReviewComment", () => {
  it("returns true for review comments flagged resolvable", () => {
    const comment = makeComment({
      kind: CommentKind.ReviewComment,
      resolvable: true,
    });
    expect(isResolvableReviewComment(comment)).toBe(true);
  });

  it("returns false when resolvable is undefined", () => {
    const comment = makeComment({ kind: CommentKind.ReviewComment });
    expect(isResolvableReviewComment(comment)).toBe(false);
  });

  it("returns false when resolvable is explicitly false", () => {
    const comment = makeComment({
      kind: CommentKind.ReviewComment,
      resolvable: false,
    });
    expect(isResolvableReviewComment(comment)).toBe(false);
  });

  it("returns false for non-review comment kinds even when resolvable=true", () => {
    const issueComment = makeComment({
      kind: CommentKind.IssueComment,
      resolvable: true,
    });
    expect(isResolvableReviewComment(issueComment)).toBe(false);
  });
});

describe("getReplyTargetGithubCommentId", () => {
  it("returns the parsed positive integer for a numeric github comment id", () => {
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: "1001" }))
    ).toBe(1001);
  });

  it("tolerates surrounding whitespace", () => {
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: " 42 " }))
    ).toBe(42);
  });

  it("returns null for non-numeric ids so the reply payload never becomes NaN", () => {
    expect(
      getReplyTargetGithubCommentId(
        makeComment({ githubCommentId: "review-1001" })
      )
    ).toBeNull();
  });

  it("returns null for empty, zero, negative, and non-integer ids", () => {
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: "" }))
    ).toBeNull();
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: "0" }))
    ).toBeNull();
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: "-5" }))
    ).toBeNull();
    expect(
      getReplyTargetGithubCommentId(makeComment({ githubCommentId: "12.5" }))
    ).toBeNull();
  });
});

describe("isResolvedComment", () => {
  it("uses the API route resolved flag instead of legacy review state", () => {
    expect(
      isResolvedComment(
        makeComment({
          state: PRReviewCommentState.Addressed,
          resolved: false,
        })
      )
    ).toBe(false);

    expect(
      isResolvedComment(
        makeComment({
          state: PRReviewCommentState.Pending,
          resolved: true,
        })
      )
    ).toBe(true);
  });
});
