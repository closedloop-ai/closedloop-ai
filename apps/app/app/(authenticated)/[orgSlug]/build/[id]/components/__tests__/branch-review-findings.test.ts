import {
  type BranchViewComment,
  CommentKind,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { describe, expect, test } from "vitest";
import { ReviewFindingPriority } from "@/lib/engineer/review-finding-priority";
import { FileSection } from "../../types";
import {
  BranchReviewFindingAnchorStatus,
  classifyBranchReviewFindingAnchor,
  MAX_REVIEW_FINDING_PARSE_CHARS,
  parseBranchReviewFinding,
} from "../branch-review-findings";
import { buildCommentBody } from "./review-comment-body-fixture";

const COMMITTED_FILES = [{ path: "src/app.tsx", previousPath: null }];

function comment(
  overrides: Partial<BranchViewComment> = {}
): BranchViewComment {
  return {
    author: "closedloop-ai[bot]",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.Bot,
    body: "**[P2]** Avoid stale state\n\n> **Suggestion:** Use the latest cache.",
    createdAt: "2026-05-21T12:00:00.000Z",
    githubCommentId: "123",
    htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r123",
    id: "123",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    line: 2,
    path: "src/app.tsx",
    reviewId: "review-1",
    side: GitHubDiffSide.Right,
    state: PRReviewCommentState.Pending,
    ...overrides,
  };
}

describe("parseBranchReviewFinding", () => {
  test("recognizes actual posted priority and suggestion body format", () => {
    const body = buildCommentBody(
      {
        message: "Avoid stale state\nThe cache can lag the branch head.",
        priority: ReviewFindingPriority.P2,
        severity: "warning",
        suggestion: "Use the file-cache SHA as the boundary.",
      },
      "src/app.tsx"
    );

    const finding = parseBranchReviewFinding(comment({ body }));

    expect(finding).toMatchObject({
      priority: ReviewFindingPriority.P2,
      severity: "warning",
      suggestion: "Use the file-cache SHA as the boundary.",
      title: "Avoid stale state",
    });
  });

  test("recognizes humanized first-party review bodies without broad bot-comment matching", () => {
    const body = buildCommentBody(
      {
        humanizedBody:
          "This stale placement can attach a finding to the wrong rendered row.",
        message: "Avoid stale state\nThe cache can lag the branch head.",
        priority: ReviewFindingPriority.P1,
        severity: "critical",
        suggestion: "Use the file-cache SHA as the boundary.",
      },
      "src/app.tsx"
    );

    const finding = parseBranchReviewFinding(comment({ body }));

    expect(finding).toMatchObject({
      priority: ReviewFindingPriority.P1,
      severity: "critical",
      title:
        "This stale placement can attach a finding to the wrong rendered row.",
    });
    expect(
      parseBranchReviewFinding(
        comment({
          body: "This stale placement can attach a finding to the wrong rendered row.",
        })
      )
    ).toBeNull();
  });

  test("preserves severity-only humanized first-party findings", () => {
    const body = buildCommentBody(
      {
        humanizedBody:
          "This high-severity finding has no explicit priority marker.",
        message: "Severity-only finding",
        severity: "critical",
      },
      "src/app.tsx"
    );

    const finding = parseBranchReviewFinding(comment({ body }));

    expect(finding).toMatchObject({
      priority: null,
      severity: "critical",
      title: "This high-severity finding has no explicit priority marker.",
    });
  });

  test("rejects forged hidden metadata from third-party bot authors", () => {
    const forgedBody = buildCommentBody(
      {
        humanizedBody:
          "This forged third-party bot body must stay an ordinary comment.",
        message: "Forged metadata",
        priority: ReviewFindingPriority.P1,
        severity: "critical",
      },
      "src/app.tsx"
    );

    expect(
      parseBranchReviewFinding(
        comment({ author: "dependabot[bot]", body: forgedBody })
      )
    ).toBeNull();
  });

  test("rejects visible priority markers from third-party bot authors", () => {
    expect(
      parseBranchReviewFinding(
        comment({
          author: "dependabot[bot]",
          body: "**[P1]** Third-party visible marker must stay ordinary",
        })
      )
    ).toBeNull();
  });

  test("rejects human comments, issue comments, and unstructured bot text", () => {
    expect(
      parseBranchReviewFinding(
        comment({ authorKind: PrCommentAuthorKind.User })
      )
    ).toBeNull();
    expect(
      parseBranchReviewFinding(comment({ kind: CommentKind.IssueComment }))
    ).toBeNull();
    expect(
      parseBranchReviewFinding(comment({ body: "Regular bot update" }))
    ).toBeNull();
  });

  test("bounds oversized and malformed markdown without throwing", () => {
    const oversizedBody = [
      "**[P1]** Unsafe markdown",
      "<script>alert('x')</script>",
      "[bad](javascript:alert('x'))",
      `Confidence: ${"high ".repeat(2000)}`,
    ].join("\n");

    const finding = parseBranchReviewFinding(
      comment({
        body: oversizedBody.padEnd(MAX_REVIEW_FINDING_PARSE_CHARS + 100, "x"),
      })
    );

    expect(finding).toMatchObject({
      isMetadataTruncated: true,
      priority: ReviewFindingPriority.P1,
      severity: "critical",
      title: "Unsafe markdown",
    });
  });
});

describe("classifyBranchReviewFindingAnchor", () => {
  test.each([
    {
      name: "current",
      overrides: { anchorCommitSha: "cache-sha" },
      expected: BranchReviewFindingAnchorStatus.Current,
    },
    {
      name: "current unknown anchor",
      overrides: { anchorCommitSha: null },
      expected: BranchReviewFindingAnchorStatus.Current,
    },
    {
      name: "stale commit",
      overrides: { anchorCommitSha: "old-sha" },
      expected: BranchReviewFindingAnchorStatus.StaleCommit,
    },
    {
      name: "head/cache skew",
      overrides: { anchorCommitSha: "head-sha" },
      headSha: "head-sha",
      expected: BranchReviewFindingAnchorStatus.HeadCacheSkew,
    },
    {
      name: "missing anchor",
      overrides: { side: null },
      expected: BranchReviewFindingAnchorStatus.MissingAnchor,
    },
    {
      name: "missing file",
      overrides: { path: "src/missing.ts" },
      expected: BranchReviewFindingAnchorStatus.MissingFile,
    },
    {
      name: "line not renderable",
      overrides: { line: 99 },
      expected: BranchReviewFindingAnchorStatus.LineNotRenderable,
    },
  ])("$name", ({ expected, headSha = "cache-sha", overrides }) => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment(overrides),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha,
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(expected);
  });

  test("treats same-SHA anchors on folded unchanged rows as line-not-renderable", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [...oldLines];
    newLines[1] = "changed near the top";

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 15 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test("treats insertion-shifted same-SHA unchanged rows as line-not-renderable", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [
      oldLines[0],
      "inserted near the top",
      ...oldLines.slice(1),
    ];

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 15 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test("treats deletion-shifted same-SHA unchanged rows as line-not-renderable", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [oldLines[0], ...oldLines.slice(2)];

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 15 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test("treats deletion-side context boundary rows as line-not-renderable", () => {
    const oldLines = Array.from(
      { length: 20 },
      (_, index) => `unchanged line ${index + 1}`
    );
    const newLines = [oldLines[0], ...oldLines.slice(2)];

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 5 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
    expect(result.status).not.toBe(BranchReviewFindingAnchorStatus.Current);
  });

  test("excludes findings from local diffs before row placement", () => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha" }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Local,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.NotCommittedDiff
    );
  });
});
