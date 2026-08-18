import {
  CommentKind,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { describe, expect, test } from "vitest";
import {
  ReviewFindingPriority,
  ReviewFindingSeverity,
} from "@/lib/engineer/review-finding-priority";
import { FileSection } from "../../types";
import {
  type BranchReviewFinding,
  BranchReviewFindingAnchorStatus,
  classifyBranchReviewFindingAnchor,
  getBranchReviewFindingAnchorStatusLabel,
  getBranchReviewFindingMarkerLabel,
  getBranchReviewFindingSeverityClassName,
  getBranchReviewFindingSeverityLabel,
  isBranchReviewFinding,
  MAX_REVIEW_FINDING_PARSE_CHARS,
  parseBranchReviewFinding,
} from "../branch-review-findings";
import {
  COMMITTED_FILES,
  comment,
} from "./branch-review-finding-anchor-fixture";
import { buildCommentBody } from "./review-comment-body-fixture";

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

  test("returns null when the body has no meaningful (non-whitespace) content", () => {
    expect(
      parseBranchReviewFinding(comment({ body: "   \n\t\n   " }))
    ).toBeNull();
  });

  test("returns null when hidden metadata is present but no title line follows it", () => {
    expect(
      parseBranchReviewFinding(
        comment({
          body: "<!-- closedloop-review-finding priority=P1 severity=critical -->\n   \n",
        })
      )
    ).toBeNull();
  });

  test("ignores an HTML comment whose tag does not match the finding metadata tag", () => {
    expect(
      parseBranchReviewFinding(
        comment({
          body: "<!-- some-other-tag priority=P1 severity=critical -->\nUnrelated title line",
        })
      )
    ).toBeNull();
  });

  test("skips malformed and unrecognized metadata assignments while still resolving known keys", () => {
    const finding = parseBranchReviewFinding(
      comment({
        body: "<!-- closedloop-review-finding malformedtoken foo=bar priority=P2 severity=warning -->\nRace condition in cache read",
      })
    );

    expect(finding).toMatchObject({
      priority: ReviewFindingPriority.P2,
      severity: ReviewFindingSeverity.Warning,
    });
  });

  test("derives severity from priority when hidden metadata omits an explicit severity", () => {
    const finding = parseBranchReviewFinding(
      comment({
        body: "<!-- closedloop-review-finding priority=P0 -->\nRace condition in cache read",
      })
    );

    expect(finding).toMatchObject({
      priority: ReviewFindingPriority.P0,
      severity: ReviewFindingSeverity.Critical,
    });
  });

  test("returns null when hidden metadata resolves to no usable priority or severity", () => {
    expect(
      parseBranchReviewFinding(
        comment({
          body: "<!-- closedloop-review-finding priority=P9 -->\nRace condition in cache read",
        })
      )
    ).toBeNull();
  });

  test("derives severity from a visible severity marker without a priority marker or hidden metadata", () => {
    const finding = parseBranchReviewFinding(
      comment({ body: "Critical: Race condition in cache read" })
    );

    expect(finding).toMatchObject({
      priority: null,
      severity: ReviewFindingSeverity.Critical,
      title: "Race condition in cache read",
    });
  });

  test("extracts confidence and LOC-savings metadata lines that have a single capture group", () => {
    const finding = parseBranchReviewFinding(
      comment({
        body: [
          "**[P2]** Avoid stale state",
          "Confidence: high",
          "LOC savings: 12 lines",
        ].join("\n"),
      })
    );

    expect(finding).toMatchObject({
      confidence: "high",
      locSavings: "12 lines",
    });
  });

  test("falls back to the generic finding title when a heading-only title strips to nothing", () => {
    const finding = parseBranchReviewFinding(
      comment({
        body: "<!-- closedloop-review-finding priority=P1 severity=critical -->\n###",
      })
    );

    expect(finding?.title).toBe("AI review finding");
  });
});

describe("isBranchReviewFinding", () => {
  test("returns true for a parseable first-party review finding", () => {
    expect(isBranchReviewFinding(comment())).toBe(true);
  });

  test("returns false for a comment that does not parse as a finding", () => {
    expect(isBranchReviewFinding(comment({ body: "Regular bot update" }))).toBe(
      false
    );
  });
});

describe("getBranchReviewFindingAnchorStatusLabel", () => {
  test.each([
    [BranchReviewFindingAnchorStatus.Current, "Current"],
    [BranchReviewFindingAnchorStatus.StaleCommit, "Outdated commit"],
    [
      BranchReviewFindingAnchorStatus.HeadCacheSkew,
      "Diff cache behind branch head",
    ],
    [BranchReviewFindingAnchorStatus.MissingAnchor, "Missing anchor"],
    [BranchReviewFindingAnchorStatus.MissingFile, "Missing file"],
    [BranchReviewFindingAnchorStatus.LineNotRenderable, "Line not visible"],
    [BranchReviewFindingAnchorStatus.NotCommittedDiff, "Not on committed diff"],
  ])("maps %s to %s", (status, expected) => {
    expect(getBranchReviewFindingAnchorStatusLabel(status)).toBe(expected);
  });
});

describe("getBranchReviewFindingSeverityLabel", () => {
  test.each([
    [ReviewFindingSeverity.Critical, "Critical"],
    [ReviewFindingSeverity.Warning, "Warning"],
    [ReviewFindingSeverity.Success, "Success"],
    [ReviewFindingSeverity.Info, "Info"],
  ])("maps %s to %s", (severity, expected) => {
    expect(getBranchReviewFindingSeverityLabel(severity)).toBe(expected);
  });
});

describe("getBranchReviewFindingSeverityClassName", () => {
  test.each([
    [
      ReviewFindingSeverity.Critical,
      "border-destructive/50 bg-destructive/10 text-destructive",
    ],
    [
      ReviewFindingSeverity.Warning,
      "border-warning/50 bg-warning/12 text-warning-foreground",
    ],
    [
      ReviewFindingSeverity.Success,
      "border-success/50 bg-success/10 text-success",
    ],
    [ReviewFindingSeverity.Info, "border-info/50 bg-info/10 text-info"],
  ])("maps %s to %s", (severity, expected) => {
    expect(getBranchReviewFindingSeverityClassName(severity)).toBe(expected);
  });
});

describe("getBranchReviewFindingMarkerLabel", () => {
  function finding(
    overrides: Partial<BranchReviewFinding> = {}
  ): BranchReviewFinding {
    return {
      comment: comment(),
      confidence: null,
      id: "finding-1",
      isMetadataTruncated: false,
      locSavings: null,
      priority: null,
      severity: ReviewFindingSeverity.Warning,
      suggestion: null,
      title: "Avoid stale state",
      ...overrides,
    };
  }

  test("includes the priority prefix when a priority is present", () => {
    expect(
      getBranchReviewFindingMarkerLabel(
        finding({ priority: ReviewFindingPriority.P2 })
      )
    ).toBe("P2 Warning: Avoid stale state");
  });

  test("omits the priority prefix when no priority was parsed", () => {
    expect(getBranchReviewFindingMarkerLabel(finding({ priority: null }))).toBe(
      "Warning: Avoid stale state"
    );
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

  test("resolves a committed file via its previous path when the comment targets a renamed file's old path", () => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha", path: "src/app.tsx" }),
      committedFiles: [
        { path: "src/renamed.tsx", previousPath: "src/app.tsx" },
      ],
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/renamed.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(BranchReviewFindingAnchorStatus.Current);
  });

  test("reports missing file with a selected-file-specific reason when the finding is anchored elsewhere", () => {
    const result = classifyBranchReviewFindingAnchor({
      comment: comment({ anchorCommitSha: "cache-sha" }),
      committedFiles: COMMITTED_FILES,
      fileCacheHeadSha: "cache-sha",
      headSha: "cache-sha",
      newContent: "one\ntwo\nthree",
      oldContent: "one\ntwo\nthree",
      selectedFilePath: "src/other-file.tsx",
      selectedFileSection: FileSection.Committed,
    });

    expect(result.status).toBe(BranchReviewFindingAnchorStatus.MissingFile);
    expect(result.reasonLabel).toBe(
      "This finding is not anchored to the selected file."
    );
  });
});
