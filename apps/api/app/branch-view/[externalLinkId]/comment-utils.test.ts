import {
  GitHubCommentThreadKind,
  GitHubDiffSide,
  PRReviewCommentState,
} from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import { toBranchViewComment } from "./comment-utils";

describe("toBranchViewComment", () => {
  it("derives resolved only from canonical CommentThread status", () => {
    expect(
      makeBranchViewComment({
        status: ThreadStatus.Open,
        legacyState: PRReviewCommentState.Addressed,
      })?.resolved
    ).toBe(false);

    expect(
      makeBranchViewComment({
        status: ThreadStatus.Open,
        legacyState: PRReviewCommentState.Dismissed,
      })?.resolved
    ).toBe(false);

    expect(
      makeBranchViewComment({
        status: ThreadStatus.Resolved,
        legacyState: PRReviewCommentState.Pending,
      })?.resolved
    ).toBe(true);
  });
});

function makeBranchViewComment(input: {
  status: ThreadStatus;
  legacyState: PRReviewCommentState;
}) {
  return toBranchViewComment({
    thread: {
      id: "thread-1",
      source: ThreadSource.Github,
      status: input.status,
      legacyState: input.legacyState,
      threadKind: GitHubCommentThreadKind.ReviewThread,
      reviewId: "review-1",
      htmlUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
      path: "src/app.ts",
      line: 42,
      commitSha: "abc123",
      side: GitHubDiffSide.Right,
      startLine: null,
      startSide: null,
      resolvable: true,
    },
    comment: {
      id: "comment-1",
      body: { type: "github_markdown", markdown: "Looks good" },
      plainText: "Looks good",
      createdAt: new Date("2026-05-29T12:00:00.000Z"),
      githubCommentId: "123",
      githubInReplyToCommentId: null,
      githubHtmlUrl: "https://github.com/acme/repo/pull/42#discussion_r1",
    },
    author: {
      login: "octocat",
      avatarUrl: null,
      profileUrl: "https://github.com/octocat",
    },
  });
}
