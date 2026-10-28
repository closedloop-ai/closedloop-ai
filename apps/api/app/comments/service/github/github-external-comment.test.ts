import { GitHubDiffSide } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  gitHubExternalComment,
  gitHubExternalReviewComment,
  gitHubReviewThreadPosition,
} from "./github-external-comment";

const COMMENT = {
  id: 11,
  html_url: "https://github.com/acme/web/pull/42#discussion_r11",
  body: "body",
  user: { id: 4242, login: "octocat" },
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:05:00.000Z",
};

describe("GitHub provider comment mapping", () => {
  it("orders a comment by its updated_at, created at its created_at", () => {
    expect(gitHubExternalComment(COMMENT)).toEqual({
      githubCommentId: 11,
      htmlUrl: COMMENT.html_url,
      bodyMarkdown: "body",
      author: COMMENT.user,
      createdAt: new Date(COMMENT.created_at),
      providerUpdatedAt: new Date(COMMENT.updated_at),
    });
  });

  it("stores fields a webhook payload omits as null, the way a REST list sends them", () => {
    const webhookShaped = { ...COMMENT, path: "src/app.ts", line: 10 };

    expect(gitHubExternalReviewComment(webhookShaped)).toEqual(
      expect.objectContaining({ githubInReplyToCommentId: null })
    );
    expect(
      gitHubReviewThreadPosition({ ...webhookShaped, side: "RIGHT" })
    ).toEqual({
      path: "src/app.ts",
      line: 10,
      originalLine: null,
      side: GitHubDiffSide.RIGHT,
      startLine: null,
      startSide: null,
      commitSha: null,
    });
  });
});
