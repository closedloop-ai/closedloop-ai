import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS,
  BRANCH_VIEW_GITHUB_COMMENT_CAPABILITIES,
  BranchViewCommentAction,
  BranchViewCommentActionRecovery,
  BranchViewCommentActionResultCode,
  BranchViewCommentSource,
  CommentKind,
  GITHUB_COMMENT_THREAD_KIND_TO_COMMENT_KIND,
  GITHUB_LEGACY_COMMENT_STATE_TO_THREAD_STATUS,
  GitHubCommentThreadKind,
  GitHubDiffSide,
  getDefaultBranchViewGithubCommentCapabilities,
  PRReviewCommentState,
  THREAD_SOURCE_TO_BRANCH_VIEW_COMMENT_SOURCE,
} from "@repo/api/src/types/branch-view";
import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import {
  BRANCH_VIEW_COMMENT_REQUEST_SCHEMAS_BY_ACTION,
  createBranchViewConversationCommentRequestSchema,
  createBranchViewInlineCommentRequestSchema,
} from "@/app/branch-view/[externalLinkId]/schemas";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const branchViewSourcePath = path.join(
  repoRoot,
  "packages/api/src/types/branch-view.ts"
);
const directWriteServicePath = path.join(
  repoRoot,
  "apps/api/app/branch-view/[externalLinkId]/comments/direct-write-service.ts"
);
const branchViewServicePath = path.join(
  repoRoot,
  "apps/api/app/branch-view/[externalLinkId]/service.ts"
);
const pullRequestReviewCommentWebhookPath = path.join(
  repoRoot,
  "apps/api/app/webhooks/github/handlers/pull-request-review-comment-handler.ts"
);
const BRANCH_VIEW_SCHEMA_IMPORT_REGEX = /branch-view-schemas/;
const ZOD_IMPORT_REGEX = /\bfrom\s+["']zod["']/;
const LEGACY_REVIEW_COMMENT_DELEGATE_REGEX = new RegExp(
  `${String.raw`\bgitHubPRReview`}Comment${String.raw`\b`}`
);
const BACKFILL_IMPORT_REGEX = /github-comment-backfill/;
const SOURCE_FILE_EXTENSION_REGEX = /\.(?:ts|tsx|js|jsx|mjs|cjs|prisma|sql)$/;
const SOURCE_SCAN_ROOTS = ["apps", "packages", "scripts", "e2e"] as const;
const LEGACY_REFERENCE_PATTERNS = [
  {
    name: "legacy model",
    regex: new RegExp(`${"GitHubPR"}${"ReviewComment"}`),
  },
  {
    name: "legacy table",
    regex: new RegExp(`${"github_pr"}_${"review_comments"}`),
  },
  {
    name: "legacy delegate",
    regex: new RegExp(`${"gitHubPR"}${"ReviewComment"}`),
  },
  {
    name: "legacy delegate plural",
    regex: new RegExp(`${"gitHubPR"}${"ReviewComments"}`),
  },
] as const;
const LEGACY_REFERENCE_ALLOWLIST = [
  /^packages\/database\/prisma\/migrations\//,
  /^apps\/api\/__tests__\/integration\/branch-artifact-migration-upgrade\.test\.ts$/,
  /^apps\/api\/__tests__\/integration\/comment-table-convergence-migration-upgrade\.test\.ts$/,
  /^apps\/api\/__tests__\/integration\/comment-table-final-drop-migration-upgrade\.test\.ts$/,
  /^apps\/api\/__tests__\/unit\/comment-contracts\.test\.ts$/,
  /^apps\/api\/__tests__\/unit\/comment-table-convergence-migration\.test\.ts$/,
  /^apps\/api\/__tests__\/unit\/comment-table-final-drop-migration\.test\.ts$/,
  /^scripts\/lint\/check-destructive-migrations\.ts$/,
] as const;
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
  it("maps uppercase persisted GitHub source to lowercase branch-view source", () => {
    expect(ThreadSource.Github).toBe("GITHUB");
    expect(BranchViewCommentSource.Github).toBe("github");
    expect(
      THREAD_SOURCE_TO_BRANCH_VIEW_COMMENT_SOURCE[ThreadSource.Github]
    ).toBe(BranchViewCommentSource.Github);
    expect(Object.values(ThreadSource)).not.toContain(
      BranchViewCommentSource.Github
    );
  });

  it("maps legacy GitHub state and thread kind through shared constants", () => {
    expect(GITHUB_LEGACY_COMMENT_STATE_TO_THREAD_STATUS).toEqual({
      [PRReviewCommentState.Pending]: ThreadStatus.Open,
      [PRReviewCommentState.Addressed]: ThreadStatus.Resolved,
      [PRReviewCommentState.Dismissed]: ThreadStatus.Resolved,
    });

    expect(GITHUB_COMMENT_THREAD_KIND_TO_COMMENT_KIND).toEqual({
      [GitHubCommentThreadKind.ReviewThread]: CommentKind.ReviewComment,
      [GitHubCommentThreadKind.IssueComment]: CommentKind.IssueComment,
    });
  });

  it("exports the full branch-view action, result, and route status contract", () => {
    expect(Object.values(BranchViewCommentAction)).toEqual([
      "create_conversation",
      "create_inline",
      "reply",
      "edit",
      "delete",
      "resolve",
      "unresolve",
    ]);
    expect(Object.values(BranchViewCommentActionResultCode)).toEqual([
      "success",
      "feature_disabled",
      "invalid_request",
      "comment_not_found",
      "unsupported_comment_kind",
      "comment_not_resolvable",
      "github_thread_missing",
      "github_write_failed",
      "github_projection_failed",
      "github_identity_required",
      "github_identity_expired",
      "unauthorized_comment_action",
      "stale_head_sha",
      "anchor_not_in_diff",
      "invalid_anchor",
      "app_authored_comment_read_only",
    ]);
    expect(Object.values(BranchViewCommentActionRecovery)).toEqual([
      "branch_view_sync",
      "direct_reprojection",
    ]);
    expect(BRANCH_VIEW_COMMENT_ACTION_RESULT_HTTP_STATUS).toMatchObject({
      [BranchViewCommentActionResultCode.Success]: 200,
      [BranchViewCommentActionResultCode.InvalidRequest]: 400,
      [BranchViewCommentActionResultCode.FeatureDisabled]: 403,
      [BranchViewCommentActionResultCode.CommentNotFound]: 404,
      [BranchViewCommentActionResultCode.UnsupportedCommentKind]: 409,
      [BranchViewCommentActionResultCode.InvalidAnchor]: 422,
      [BranchViewCommentActionResultCode.GithubWriteFailed]: 502,
      [BranchViewCommentActionResultCode.GithubProjectionFailed]: 202,
    });
  });

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

  it("keeps branch-view contracts client-safe and validation schemas backend-owned", () => {
    const branchViewSource = readFileSync(branchViewSourcePath, "utf8");

    expect(branchViewSource).not.toMatch(BRANCH_VIEW_SCHEMA_IMPORT_REGEX);
    expect(branchViewSource).not.toMatch(ZOD_IMPORT_REGEX);
  });

  it("keeps direct branch-view writes unified-only after legacy cleanup", () => {
    const directWriteServiceSource = readFileSync(
      directWriteServicePath,
      "utf8"
    );

    expect(directWriteServiceSource).not.toMatch(
      LEGACY_REVIEW_COMMENT_DELEGATE_REGEX
    );
  });

  it("normalizes only exact GitHub diff side values", () => {
    expect(normalizeGitHubDiffSide("LEFT")).toBe(GitHubDiffSide.Left);
    expect(normalizeGitHubDiffSide("RIGHT")).toBe(GitHubDiffSide.Right);
    expect(normalizeGitHubDiffSide("left")).toBeNull();
    expect(normalizeGitHubDiffSide("")).toBeNull();
    expect(normalizeGitHubDiffSide(null)).toBeNull();
    expect(normalizeGitHubDiffSide(undefined)).toBeNull();
  });

  it("keeps live branch-view sync and review-comment webhooks off the retired backfill module", () => {
    expect(readFileSync(branchViewServicePath, "utf8")).not.toMatch(
      BACKFILL_IMPORT_REGEX
    );
    expect(
      readFileSync(pullRequestReviewCommentWebhookPath, "utf8")
    ).not.toMatch(BACKFILL_IMPORT_REGEX);
  });

  it("has no live legacy review-comment model, table, or delegate references outside validation allowlists", () => {
    const offenders = scanSourceFilesForLegacyReferences();

    expect(offenders).toEqual([]);
  }, 15_000);
});

function scanSourceFilesForLegacyReferences(): string[] {
  const offenders: string[] = [];
  for (const root of SOURCE_SCAN_ROOTS) {
    for (const filePath of walkFiles(path.join(repoRoot, root))) {
      const relativePath = path.relative(repoRoot, filePath);
      if (isAllowedLegacyReferencePath(relativePath)) {
        continue;
      }
      if (!existsSync(filePath)) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
      for (const pattern of LEGACY_REFERENCE_PATTERNS) {
        if (pattern.regex.test(source)) {
          offenders.push(`${relativePath}: ${pattern.name}`);
        }
      }
    }
  }
  return offenders.sort();
}

function walkFiles(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    // "generated" covers Prisma client output (packages/database/generated,
    // apps/desktop/src/main/database/generated): derived from schema.prisma,
    // not source, and large enough to push this scan past its timeout.
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "dist" ||
      entry === "generated"
    ) {
      continue;
    }
    files.push(...walkFiles(path.join(root, entry)));
  }
  return files.filter((filePath) => SOURCE_FILE_EXTENSION_REGEX.test(filePath));
}

function isAllowedLegacyReferencePath(relativePath: string): boolean {
  return LEGACY_REFERENCE_ALLOWLIST.some((pattern) =>
    pattern.test(relativePath)
  );
}
