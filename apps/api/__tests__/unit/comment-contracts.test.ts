import {
  BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES,
  BranchViewCommentAction,
  GitHubDiffSide,
  getDefaultBranchViewGithubCommentCapabilities,
} from "@repo/api/src/types/branch-view";
import { describe, expect, it } from "vitest";
import {
  BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION,
  createBranchViewConversationCommentRequestSchema,
  createBranchViewInlineCommentRequestSchema,
} from "@/app/branch-view/[externalLinkId]/schemas";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";

const FORGED_REQUEST_FIELDS = [
  "organizationId",
  "pullRequestDetailId",
  "githubCommentId",
  "githubReviewThreadId",
  "threadId",
  "source",
  "canReply",
  "canEdit",
  "canDelete",
  "canResolve",
  "canUnresolve",
] as const;

describe("comment shared contracts", () => {
  it("strictly validates request envelopes by action", () => {
    expect(
      BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION[
        BranchViewCommentAction.CreateConversation
      ].safeParse({ body: "start a conversation" }).success
    ).toBe(true);
    expect(
      BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION[
        BranchViewCommentAction.CreateInline
      ].safeParse({
        body: "inline note",
        path: "src/file.ts",
        line: 12,
        side: GitHubDiffSide.Right,
        expectedHeadSha: "abc123",
      }).success
    ).toBe(true);
    expect(
      BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION[
        BranchViewCommentAction.Reply
      ].safeParse({
        commentGithubId: 123_456,
        body: "reply",
      }).success
    ).toBe(true);
    expect(
      BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION[
        BranchViewCommentAction.Delete
      ].safeParse({}).success
    ).toBe(true);
  });

  it("keeps the reply action envelope on the canonical commentGithubId contract", () => {
    const replySchema =
      BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION[
        BranchViewCommentAction.Reply
      ];

    expect(
      replySchema.safeParse({
        commentGithubId: 123_456,
        body: "reply",
      }).success
    ).toBe(true);
    expect(
      replySchema.safeParse({
        body: "reply",
      }).success
    ).toBe(false);
    expect(
      replySchema.safeParse({
        commentId: 123_456,
        body: "reply",
      }).success
    ).toBe(false);
    expect(
      replySchema.safeParse({
        commentGithubId: "123456",
        body: "reply",
      }).success
    ).toBe(false);
  });

  it("rejects anchors on conversation comments and requires inline anchors", () => {
    expect(
      createBranchViewConversationCommentRequestSchema.safeParse({
        body: "not anchored",
        path: "src/file.ts",
        line: 12,
        side: GitHubDiffSide.Right,
        expectedHeadSha: "abc123",
      }).success
    ).toBe(false);

    expect(
      createBranchViewInlineCommentRequestSchema.safeParse({
        body: "missing anchor fields",
      }).success
    ).toBe(false);
  });

  it("rejects half-formed multiline inline anchors", () => {
    const inlineAnchorRequest = {
      body: "inline note",
      path: "src/file.ts",
      line: 12,
      side: GitHubDiffSide.Right,
      expectedHeadSha: "abc123",
    };

    expect(
      createBranchViewInlineCommentRequestSchema.safeParse({
        ...inlineAnchorRequest,
        startLine: 10,
      }).success
    ).toBe(false);
    expect(
      createBranchViewInlineCommentRequestSchema.safeParse({
        ...inlineAnchorRequest,
        startSide: GitHubDiffSide.Right,
      }).success
    ).toBe(false);
    expect(
      createBranchViewInlineCommentRequestSchema.safeParse({
        ...inlineAnchorRequest,
        startLine: 10,
        startSide: GitHubDiffSide.Right,
      }).success
    ).toBe(true);
  });

  it("rejects forged ownership, source, comment id, and capability fields", () => {
    for (const field of FORGED_REQUEST_FIELDS) {
      expect(
        createBranchViewInlineCommentRequestSchema.safeParse({
          body: "inline note",
          path: "src/file.ts",
          line: 12,
          side: GitHubDiffSide.Right,
          expectedHeadSha: "abc123",
          [field]: "forged",
        }).success
      ).toBe(false);
    }
  });

  it("defaults omitted capability hints to false", () => {
    const defaults = getDefaultBranchViewGithubCommentCapabilities();

    expect(defaults).toEqual({
      [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canReply]: false,
      [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canEdit]: false,
      [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canDelete]: false,
      [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canResolve]: false,
      [BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES.canUnresolve]: false,
    });
  });

  it("normalizes only exact GitHub diff side values", () => {
    expect(normalizeGitHubDiffSide("LEFT")).toBe(GitHubDiffSide.Left);
    expect(normalizeGitHubDiffSide("RIGHT")).toBe(GitHubDiffSide.Right);
    expect(normalizeGitHubDiffSide("left")).toBeNull();
    expect(normalizeGitHubDiffSide("")).toBeNull();
    expect(normalizeGitHubDiffSide(null)).toBeNull();
    expect(normalizeGitHubDiffSide(undefined)).toBeNull();
  });
});
