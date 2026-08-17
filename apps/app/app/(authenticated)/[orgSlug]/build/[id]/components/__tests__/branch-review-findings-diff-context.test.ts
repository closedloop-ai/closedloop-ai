import { GitHubDiffSide } from "@repo/api/src/types/branch-view";
import { describe, expect, test } from "vitest";
import { FileSection } from "../../types";
import {
  BranchReviewFindingAnchorStatus,
  classifyBranchReviewFindingAnchor,
} from "../branch-review-findings";
import {
  COMMITTED_FILES,
  comment,
} from "./branch-review-finding-anchor-fixture";

/**
 * Focused coverage for classifyBranchReviewFindingAnchor's rendered-diff-context
 * internals (isRenderableLine boundary checks, the null-content bypass, and the
 * patience-diff anchor search), split from branch-review-findings.test.ts so
 * that file stays scoped to parsing and top-level classification.
 */
describe("classifyBranchReviewFindingAnchor rendered diff context", () => {
  test("treats a zero comment line as never renderable", () => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 0 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test("treats a left-side line beyond the old content's line count as not renderable", () => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment({
        anchorCommitSha: "cache-sha",
        line: 99,
        side: GitHubDiffSide.Left,
      }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test.each([
    [false, BranchReviewFindingAnchorStatus.LineNotRenderable],
    [true, BranchReviewFindingAnchorStatus.Current],
  ])("right-side isNew=%s short-circuits the rendered diff context window", (isNew, expected) => {
    const oldLines = [
      "line1",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "old-last",
    ];
    const newLines = [
      "line1",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "new-last",
    ];

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 1 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      isNew,
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(expected);
  });

  test.each([
    [false, BranchReviewFindingAnchorStatus.LineNotRenderable],
    [true, BranchReviewFindingAnchorStatus.Current],
  ])("left-side isDeleted=%s short-circuits the rendered diff context window", (isDeleted, expected) => {
    const oldLines = [
      "old-first",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "line10",
    ];
    const newLines = [
      "new-first",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "line10",
    ];

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({
        anchorCommitSha: "cache-sha",
        line: 10,
        side: GitHubDiffSide.Left,
      }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      isDeleted,
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(expected);
  });

  test("treats a left-side line as renderable when the new content has not loaded, bypassing the diff-context window", () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({
        anchorCommitSha: "cache-sha",
        line: 1,
        side: GitHubDiffSide.Left,
      }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: null,
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(BranchReviewFindingAnchorStatus.Current);
  });

  test("treats an empty (non-null) old content string as zero lines rather than bypassing the count check", () => {
    const newLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);

    const result = classifyBranchReviewFindingAnchor({
      comment: comment({
        anchorCommitSha: "cache-sha",
        line: 1,
        side: GitHubDiffSide.Left,
      }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: "",
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });

  test("resolves multiple patience-diff anchors within a single changed region without misplacing the rendered window", () => {
    const commonPrefix = ["c1", "c2", "c3", "c4", "c5"];
    const commonSuffix = ["c6", "c7", "c8", "c9", "c10"];
    const oldLines = [...commonPrefix, "A", "removed1", "B", ...commonSuffix];
    const newLines = [...commonPrefix, "A", "inserted1", "B", ...commonSuffix];

    const nearChangeLine = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 7 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });
    const farFromChangeLine = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", line: 1 }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: newLines.join("\n"),
      oldContent: oldLines.join("\n"),
      selectedFilePath: "src/app.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(nearChangeLine.status).toBe(BranchReviewFindingAnchorStatus.Current);
    expect(farFromChangeLine.status).toBe(
      BranchReviewFindingAnchorStatus.LineNotRenderable
    );
  });
});
