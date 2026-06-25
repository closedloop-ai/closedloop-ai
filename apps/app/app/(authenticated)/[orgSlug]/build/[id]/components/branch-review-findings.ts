import {
  type BranchViewComment,
  CommentKind,
  GitHubDiffSide,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import {
  REVIEW_FINDING_METADATA_TAG,
  type ReviewFindingPriority,
  ReviewFindingSeverity,
  type ReviewFindingSeverity as ReviewFindingSeverityType,
  reviewFindingPriorityToSeverity,
  toReviewFindingPriority,
} from "@/lib/engineer/review-finding-priority";
import { getBranchViewCommentUiId } from "../comment-context";
import { FileSection, type FileSection as FileSectionType } from "../types";

/** Anchor states shared by Branch View diff markers, unplaced cards, filters, and tests. */
export const BranchReviewFindingAnchorStatus = {
  Current: "current",
  StaleCommit: "stale_commit",
  HeadCacheSkew: "head_cache_skew",
  MissingAnchor: "missing_anchor",
  MissingFile: "missing_file",
  LineNotRenderable: "line_not_renderable",
  NotCommittedDiff: "not_committed_diff",
} as const;
/** Supported Branch View placement outcomes for a parsed AI review finding. */
export type BranchReviewFindingAnchorStatus =
  (typeof BranchReviewFindingAnchorStatus)[keyof typeof BranchReviewFindingAnchorStatus];

/**
 * Maximum comment body prefix parsed for finding metadata.
 * The full body is still rendered by CommentMarkdown; this cap only bounds
 * identity/detail extraction for oversized review comments.
 */
export const MAX_REVIEW_FINDING_PARSE_CHARS = 8000;

const PRIORITY_MARKER_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*)?\[([Pp][0-3])\](?:\*\*)?\s*(.+)?$/u;
const SEVERITY_MARKER_PATTERN =
  /^(?:[-*]\s*)?(?:\*\*)?\[?(critical|warning|info|success)\]?(?:\*\*)?\s*[:|-]\s*(.+)$/iu;
const SUGGESTION_PATTERN =
  /^(?:>\s*)?(?:\*\*)?(Suggestion|Action|Suggested action):(?:\*\*)?\s*(.+)$/iu;
const CONFIDENCE_PATTERN = /^(?:>\s*)?(?:\*\*)?Confidence:(?:\*\*)?\s*(.+)$/iu;
const LOC_SAVINGS_PATTERN =
  /^(?:>\s*)?(?:\*\*)?(?:LOC savings|Lines saved|LOC-savings):(?:\*\*)?\s*(.+)$/iu;
const MARKDOWN_HEADING_MARKER_PATTERN = /^#+\s*/u;
const WHITESPACE_PATTERN = /\s+/u;
const RENDERED_DIFF_CONTEXT_LINES = 3;
const MIN_COLLAPSED_DIFF_LINE_COUNT = RENDERED_DIFF_CONTEXT_LINES * 2 + 1;
// Hidden metadata is trusted only from the GitHub App login used by our review poster.
const FIRST_PARTY_REVIEW_AUTHOR_LOGINS = new Set(["closedloop-ai[bot]"]);

/**
 * Branch View's normalized representation of a bot-authored AI review finding.
 * The `comment` remains the source of truth for body, path, side, line, and
 * freshness; parsed fields are display metadata only.
 */
export type BranchReviewFinding = {
  id: string;
  comment: BranchViewComment;
  priority: ReviewFindingPriority | null;
  severity: ReviewFindingSeverityType;
  title: string;
  suggestion: string | null;
  confidence: string | null;
  locSavings: string | null;
  isMetadataTruncated: boolean;
};

/** Placement classification returned before the diff decides marker versus unplaced rendering. */
export type BranchReviewFindingAnchorClassification = {
  status: BranchReviewFindingAnchorStatus;
  reasonLabel: string | null;
  side: GitHubDiffSide | null;
  line: number | null;
};

type ClassifyBranchReviewFindingAnchorInput = {
  comment: BranchViewComment;
  committedFiles: Array<{ path: string; previousPath?: string | null }>;
  fileCacheHeadSha: string | null;
  headSha?: string | null;
  isDeleted?: boolean;
  isNew?: boolean;
  newContent?: string | null;
  oldContent?: string | null;
  selectedFilePath?: string | null;
  selectedFileSection?: FileSectionType | null;
};

/**
 * Parse a Branch View GitHub review comment as a structured AI review finding.
 * Parsing is intentionally bounded and presentation-only; row placement and
 * mutation capability never depend on best-effort body metadata.
 */
export function parseBranchReviewFinding(
  comment: BranchViewComment
): BranchReviewFinding | null {
  if (
    comment.kind !== CommentKind.ReviewComment ||
    comment.authorKind !== PrCommentAuthorKind.Bot ||
    !isFirstPartyReviewAuthor(comment.author)
  ) {
    return null;
  }

  const bodyPrefix = comment.body.slice(0, MAX_REVIEW_FINDING_PARSE_CHARS);
  const meaningfulLines = bodyPrefix
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstMeaningfulLine = meaningfulLines[0];
  if (!firstMeaningfulLine) {
    return null;
  }

  const metadata = parseReviewFindingMetadataLine(firstMeaningfulLine);
  const titleLine = metadata ? (meaningfulLines[1] ?? "") : firstMeaningfulLine;
  if (!titleLine) {
    return null;
  }

  const priorityMatch = PRIORITY_MARKER_PATTERN.exec(titleLine);
  const severityMatch = SEVERITY_MARKER_PATTERN.exec(titleLine);
  if (!(metadata || priorityMatch || severityMatch)) {
    return null;
  }

  const priority = priorityMatch
    ? toReviewFindingPriority(priorityMatch[1])
    : (metadata?.priority ?? null);
  const severity = priority
    ? reviewFindingPriorityToSeverity(priority)
    : (metadata?.severity ??
      severityLabelToLevel(severityMatch?.[1] ?? "info"));
  const rawTitle = priorityMatch?.[2] ?? severityMatch?.[2] ?? titleLine;

  return {
    id: getBranchViewCommentUiId(comment),
    comment,
    priority,
    severity,
    title: normalizeFindingTitle(rawTitle),
    ...parseOptionalFindingMetadata(bodyPrefix),
    isMetadataTruncated: comment.body.length > MAX_REVIEW_FINDING_PARSE_CHARS,
  };
}

/** Return whether a comment is a Branch View AI review finding without exposing parsed metadata. */
export function isBranchReviewFinding(comment: BranchViewComment): boolean {
  return parseBranchReviewFinding(comment) !== null;
}

/**
 * Classify whether a parsed finding can be attached to a committed diff row.
 * `fileCacheHeadSha` is the rendered-content freshness boundary; a matching
 * branch head alone is never enough to make a marker current.
 */
export function classifyBranchReviewFindingAnchor({
  comment,
  committedFiles,
  fileCacheHeadSha,
  headSha = null,
  isDeleted = false,
  isNew = false,
  newContent = null,
  oldContent = null,
  selectedFilePath = null,
  selectedFileSection = FileSection.Committed,
}: ClassifyBranchReviewFindingAnchorInput): BranchReviewFindingAnchorClassification {
  if (selectedFileSection !== FileSection.Committed) {
    return classification(
      BranchReviewFindingAnchorStatus.NotCommittedDiff,
      "Findings are shown only on committed diffs.",
      null,
      null
    );
  }

  if (!(comment.path && comment.side && comment.line !== null)) {
    return classification(
      BranchReviewFindingAnchorStatus.MissingAnchor,
      "This finding is missing a file, side, or line anchor.",
      comment.side ?? null,
      comment.line
    );
  }

  const committedFile = resolveCommittedFindingFile(
    committedFiles,
    comment.path
  );
  if (!committedFile) {
    return classification(
      BranchReviewFindingAnchorStatus.MissingFile,
      "This finding refers to a file no longer in this branch.",
      comment.side,
      comment.line
    );
  }

  if (selectedFilePath && committedFile.path !== selectedFilePath) {
    return classification(
      BranchReviewFindingAnchorStatus.MissingFile,
      "This finding is not anchored to the selected file.",
      comment.side,
      comment.line
    );
  }

  if (
    comment.anchorCommitSha &&
    headSha &&
    fileCacheHeadSha &&
    comment.anchorCommitSha === headSha &&
    headSha !== fileCacheHeadSha
  ) {
    return classification(
      BranchReviewFindingAnchorStatus.HeadCacheSkew,
      "This finding targets the branch head, but the displayed diff cache is older.",
      comment.side,
      comment.line
    );
  }

  if (
    comment.anchorCommitSha &&
    (!fileCacheHeadSha || comment.anchorCommitSha !== fileCacheHeadSha)
  ) {
    return classification(
      BranchReviewFindingAnchorStatus.StaleCommit,
      "This finding was anchored to a different commit.",
      comment.side,
      comment.line
    );
  }

  if (
    hasRenderableContent(newContent, oldContent) &&
    !isRenderableLine({
      isDeleted,
      isNew,
      line: comment.line,
      newContent,
      oldContent,
      side: comment.side,
    })
  ) {
    return classification(
      BranchReviewFindingAnchorStatus.LineNotRenderable,
      "This finding's line is not visible in the rendered diff.",
      comment.side,
      comment.line
    );
  }

  return classification(
    BranchReviewFindingAnchorStatus.Current,
    null,
    comment.side,
    comment.line
  );
}

/** Human-readable label for Branch View finding placement status badges. */
export function getBranchReviewFindingAnchorStatusLabel(
  status: BranchReviewFindingAnchorStatus
): string {
  if (status === BranchReviewFindingAnchorStatus.Current) {
    return "Current";
  }
  if (status === BranchReviewFindingAnchorStatus.StaleCommit) {
    return "Outdated commit";
  }
  if (status === BranchReviewFindingAnchorStatus.HeadCacheSkew) {
    return "Diff cache behind branch head";
  }
  if (status === BranchReviewFindingAnchorStatus.MissingAnchor) {
    return "Missing anchor";
  }
  if (status === BranchReviewFindingAnchorStatus.MissingFile) {
    return "Missing file";
  }
  if (status === BranchReviewFindingAnchorStatus.LineNotRenderable) {
    return "Line not visible";
  }
  return "Not on committed diff";
}

/** Human-readable label for a parsed finding severity. */
export function getBranchReviewFindingSeverityLabel(
  severity: ReviewFindingSeverityType
): string {
  if (severity === ReviewFindingSeverity.Critical) {
    return "Critical";
  }
  if (severity === ReviewFindingSeverity.Warning) {
    return "Warning";
  }
  if (severity === ReviewFindingSeverity.Success) {
    return "Success";
  }
  return "Info";
}

/** Accessible marker text shared by inline finding buttons and tests. */
export function getBranchReviewFindingMarkerLabel(
  finding: BranchReviewFinding
): string {
  const severity = getBranchReviewFindingSeverityLabel(finding.severity);
  const priority = finding.priority ? `${finding.priority} ` : "";
  return `${priority}${severity}: ${finding.title}`;
}

/** Tailwind class ownership for severity-colored Branch View finding badges. */
export function getBranchReviewFindingSeverityClassName(
  severity: ReviewFindingSeverityType
): string {
  if (severity === ReviewFindingSeverity.Critical) {
    return "border-destructive/50 bg-destructive/10 text-destructive";
  }
  if (severity === ReviewFindingSeverity.Warning) {
    return "border-warning/50 bg-warning/12 text-warning-foreground";
  }
  if (severity === ReviewFindingSeverity.Success) {
    return "border-success/50 bg-success/10 text-success";
  }
  return "border-info/50 bg-info/10 text-info";
}

function parseReviewFindingMetadataLine(line: string): {
  priority: ReviewFindingPriority | null;
  severity: ReviewFindingSeverityType;
} | null {
  if (!(line.startsWith("<!--") && line.endsWith("-->"))) {
    return null;
  }
  const content = line.slice(4, -3).trim();
  const [tag, ...assignments] = content.split(WHITESPACE_PATTERN);
  if (tag !== REVIEW_FINDING_METADATA_TAG) {
    return null;
  }

  let priority: ReviewFindingPriority | null = null;
  let severity: ReviewFindingSeverityType | null = null;
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = assignment.slice(0, separatorIndex);
    const value = assignment.slice(separatorIndex + 1);
    if (key === "priority") {
      priority = toReviewFindingPriority(value);
    }
    if (key === "severity") {
      severity = severityLabelToLevel(value);
    }
  }

  const resolvedSeverity =
    severity ?? (priority ? reviewFindingPriorityToSeverity(priority) : null);
  if (!resolvedSeverity) {
    return null;
  }
  return {
    priority,
    severity: resolvedSeverity,
  };
}

function isFirstPartyReviewAuthor(login: string): boolean {
  return FIRST_PARTY_REVIEW_AUTHOR_LOGINS.has(login.toLowerCase());
}

function parseOptionalFindingMetadata(bodyPrefix: string): {
  confidence: string | null;
  locSavings: string | null;
  suggestion: string | null;
} {
  let confidence: string | null = null;
  let locSavings: string | null = null;
  let suggestion: string | null = null;

  for (const rawLine of bodyPrefix.split("\n")) {
    const line = rawLine.trim();
    if (!suggestion) {
      suggestion = extractMetadataLine(line, SUGGESTION_PATTERN);
    }
    if (!confidence) {
      confidence = extractMetadataLine(line, CONFIDENCE_PATTERN);
    }
    if (!locSavings) {
      locSavings = extractMetadataLine(line, LOC_SAVINGS_PATTERN);
    }
  }

  return { confidence, locSavings, suggestion };
}

function extractMetadataLine(line: string, pattern: RegExp): string | null {
  const match = pattern.exec(line);
  if (!match) {
    return null;
  }
  return match[2]?.trim() ?? match[1]?.trim() ?? null;
}

function severityLabelToLevel(label: string): ReviewFindingSeverityType {
  const normalized = label.toLowerCase();
  if (normalized === ReviewFindingSeverity.Critical) {
    return ReviewFindingSeverity.Critical;
  }
  if (normalized === ReviewFindingSeverity.Warning) {
    return ReviewFindingSeverity.Warning;
  }
  if (normalized === ReviewFindingSeverity.Success) {
    return ReviewFindingSeverity.Success;
  }
  return ReviewFindingSeverity.Info;
}

function normalizeFindingTitle(rawTitle: string): string {
  const stripped = rawTitle
    .replace(MARKDOWN_HEADING_MARKER_PATTERN, "")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped || "AI review finding";
}

function classification(
  status: BranchReviewFindingAnchorStatus,
  reasonLabel: string | null,
  side: GitHubDiffSide | null,
  line: number | null
): BranchReviewFindingAnchorClassification {
  return { status, reasonLabel, side, line };
}

function resolveCommittedFindingFile(
  files: Array<{ path: string; previousPath?: string | null }>,
  path: string
): { path: string; previousPath?: string | null } | null {
  const direct = files.find((file) => file.path === path);
  if (direct) {
    return direct;
  }
  return files.find((file) => file.previousPath === path) ?? null;
}

function hasRenderableContent(
  newContent: string | null,
  oldContent: string | null
): boolean {
  return newContent !== null || oldContent !== null;
}

function isRenderableLine(input: {
  isDeleted: boolean;
  isNew: boolean;
  line: number;
  newContent: string | null;
  oldContent: string | null;
  side: GitHubDiffSide;
}): boolean {
  const { isDeleted, isNew, line, newContent, oldContent, side } = input;
  if (line < 1) {
    return false;
  }
  if (side === GitHubDiffSide.Right) {
    if (line > getLineCount(newContent)) {
      return false;
    }
    return (
      isNew ||
      isLineInRenderedDiffContext(
        GitHubDiffSide.Right,
        line,
        newContent,
        oldContent
      )
    );
  }
  if (line > getLineCount(oldContent)) {
    return false;
  }
  return (
    isDeleted ||
    isLineInRenderedDiffContext(
      GitHubDiffSide.Left,
      line,
      newContent,
      oldContent
    )
  );
}

function isLineInRenderedDiffContext(
  side: GitHubDiffSide,
  line: number,
  newContent: string | null,
  oldContent: string | null
): boolean {
  if (newContent === null || oldContent === null) {
    return true;
  }
  const newLines = splitContentLines(newContent);
  const oldLines = splitContentLines(oldContent);
  const maxLineCount = Math.max(newLines.length, oldLines.length);
  if (maxLineCount <= MIN_COLLAPSED_DIFF_LINE_COUNT) {
    return true;
  }

  for (const range of getRenderedDiffContextRanges(oldLines, newLines)) {
    const start =
      side === GitHubDiffSide.Right ? range.newStart : range.oldStart;
    const end = side === GitHubDiffSide.Right ? range.newEnd : range.oldEnd;
    if (line >= start && line <= end) {
      return true;
    }
  }
  return false;
}

type DiffChangedRegion = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

type RenderedDiffContextRange = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

/**
 * Build rendered hunk ranges from a line-level patience diff.
 * This avoids treating insertion/deletion-shifted unchanged rows as changed
 * solely because old and new arrays no longer share the same index.
 */
function getRenderedDiffContextRanges(
  oldLines: string[],
  newLines: string[]
): RenderedDiffContextRange[] {
  const regions: DiffChangedRegion[] = [];
  collectChangedRegions({
    newEnd: newLines.length,
    newLines,
    newStart: 0,
    oldEnd: oldLines.length,
    oldLines,
    oldStart: 0,
    regions,
  });
  return regions.map((region) =>
    toRenderedRange(region, oldLines.length, newLines.length)
  );
}

function collectChangedRegions(input: {
  oldLines: string[];
  newLines: string[];
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  regions: DiffChangedRegion[];
}): void {
  let { oldStart, oldEnd, newStart, newEnd } = input;
  const { oldLines, newLines, regions } = input;

  while (
    oldStart < oldEnd &&
    newStart < newEnd &&
    oldLines[oldStart] === newLines[newStart]
  ) {
    oldStart += 1;
    newStart += 1;
  }

  while (
    oldStart < oldEnd &&
    newStart < newEnd &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  if (oldStart === oldEnd && newStart === newEnd) {
    return;
  }

  const anchors = findPatienceAnchors({
    newEnd,
    newLines,
    newStart,
    oldEnd,
    oldLines,
    oldStart,
  });
  if (anchors.length === 0) {
    regions.push({ oldStart, oldEnd, newStart, newEnd });
    return;
  }

  let nextOldStart = oldStart;
  let nextNewStart = newStart;
  for (const anchor of anchors) {
    collectChangedRegions({
      newEnd: anchor.newIndex,
      newLines,
      newStart: nextNewStart,
      oldEnd: anchor.oldIndex,
      oldLines,
      oldStart: nextOldStart,
      regions,
    });
    nextOldStart = anchor.oldIndex + 1;
    nextNewStart = anchor.newIndex + 1;
  }
  collectChangedRegions({
    newEnd,
    newLines,
    newStart: nextNewStart,
    oldEnd,
    oldLines,
    oldStart: nextOldStart,
    regions,
  });
}

type DiffAnchor = {
  oldIndex: number;
  newIndex: number;
};

function findPatienceAnchors(input: {
  oldLines: string[];
  newLines: string[];
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}): DiffAnchor[] {
  const oldUniqueIndexes = getUniqueLineIndexes(
    input.oldLines,
    input.oldStart,
    input.oldEnd
  );
  const newUniqueIndexes = getUniqueLineIndexes(
    input.newLines,
    input.newStart,
    input.newEnd
  );
  const pairs: DiffAnchor[] = [];
  for (const [line, newIndex] of newUniqueIndexes) {
    const oldIndex = oldUniqueIndexes.get(line);
    if (oldIndex !== undefined) {
      pairs.push({ oldIndex, newIndex });
    }
  }
  return longestIncreasingOldIndexSubsequence(pairs);
}

function getUniqueLineIndexes(
  lines: string[],
  start: number,
  end: number
): Map<string, number> {
  const indexes = new Map<string, number>();
  const duplicateLines = new Set<string>();
  for (let index = start; index < end; index++) {
    const line = lines[index];
    if (duplicateLines.has(line)) {
      continue;
    }
    if (indexes.has(line)) {
      indexes.delete(line);
      duplicateLines.add(line);
      continue;
    }
    indexes.set(line, index);
  }
  return indexes;
}

function longestIncreasingOldIndexSubsequence(
  pairs: DiffAnchor[]
): DiffAnchor[] {
  if (pairs.length <= 1) {
    return pairs;
  }
  const predecessorIndexes = Array.from({ length: pairs.length }, () => -1);
  const tails: number[] = [];

  pairs.forEach((pair, pairIndex) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (pairs[tails[mid]].oldIndex < pair.oldIndex) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (low > 0) {
      predecessorIndexes[pairIndex] = tails[low - 1];
    }
    tails[low] = pairIndex;
  });

  const sequence: DiffAnchor[] = [];
  let currentIndex = tails.at(-1) ?? -1;
  while (currentIndex >= 0) {
    sequence.push(pairs[currentIndex]);
    currentIndex = predecessorIndexes[currentIndex];
  }
  return sequence.reverse();
}

function toRenderedRange(
  region: DiffChangedRegion,
  oldLineCount: number,
  newLineCount: number
): RenderedDiffContextRange {
  const oldRange = toRenderedSideRange(
    region.oldStart,
    region.oldEnd,
    oldLineCount
  );
  const newRange = toRenderedSideRange(
    region.newStart,
    region.newEnd,
    newLineCount
  );
  return {
    oldStart: oldRange.start,
    oldEnd: oldRange.end,
    newStart: newRange.start,
    newEnd: newRange.end,
  };
}

function toRenderedSideRange(
  startIndex: number,
  endIndex: number,
  lineCount: number
): { start: number; end: number } {
  if (lineCount === 0) {
    return { start: 0, end: 0 };
  }
  if (startIndex === endIndex) {
    return {
      start: Math.max(1, startIndex - RENDERED_DIFF_CONTEXT_LINES + 1),
      end: Math.min(lineCount, startIndex + RENDERED_DIFF_CONTEXT_LINES),
    };
  }

  const startLine = startIndex + 1;
  const endLine = endIndex;
  return {
    start: Math.max(1, startLine - RENDERED_DIFF_CONTEXT_LINES),
    end: Math.min(lineCount, endLine + RENDERED_DIFF_CONTEXT_LINES),
  };
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split("\n");
}

function getLineCount(content: string | null): number {
  if (content === null) {
    return 0;
  }
  return splitContentLines(content).length;
}
