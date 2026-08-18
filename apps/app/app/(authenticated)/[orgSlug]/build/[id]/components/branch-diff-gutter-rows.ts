import type { GitHubDiffSide } from "@repo/api/src/types/branch-view";
import {
  type BranchReviewFinding,
  type BranchReviewFindingAnchorClassification,
  BranchReviewFindingAnchorStatus,
} from "./branch-review-findings";
import type { CommentThread } from "./comment-threads";

export type ClassifiedBranchReviewFinding = {
  classification: BranchReviewFindingAnchorClassification;
  finding: BranchReviewFinding;
};

export type InlineCommentRange = {
  side: GitHubDiffSide;
  startLine: number;
  endLine: number;
};

export type LineBracketInfo = { isStart: boolean; isEnd: boolean };

/** Stable key for a gutter row, shared by the lookup maps and the gutter lookup. */
export function gutterRowKey(
  side: GitHubDiffSide | null,
  line: number | null
): string {
  return `${side}:${line}`;
}

/** Group inline threads by their root's (side, line) anchor for O(1) gutter lookup. */
export function buildThreadsByRow(
  threads: CommentThread[]
): Map<string, CommentThread[]> {
  const map = new Map<string, CommentThread[]>();
  for (const thread of threads) {
    const key = gutterRowKey(thread.root.side ?? null, thread.root.line);
    const existing = map.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      map.set(key, [thread]);
    }
  }
  return map;
}

/** Group current-anchored findings by (side, line) for O(1) gutter lookup. */
export function buildFindingsByRow(
  findings: ClassifiedBranchReviewFinding[]
): Map<string, ClassifiedBranchReviewFinding[]> {
  const map = new Map<string, ClassifiedBranchReviewFinding[]>();
  for (const item of findings) {
    if (
      item.classification.status !== BranchReviewFindingAnchorStatus.Current
    ) {
      continue;
    }
    const key = gutterRowKey(
      item.classification.side,
      item.classification.line
    );
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * Expand multi-line comment ranges into a per-(side, line) bracket lookup so the
 * gutter resolves bracket state in O(1) instead of scanning every range per row.
 * First range covering a line wins, matching the prior linear-scan behavior.
 */
export function buildBracketByRow(
  ranges: InlineCommentRange[]
): Map<string, LineBracketInfo> {
  const map = new Map<string, LineBracketInfo>();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line++) {
      const key = gutterRowKey(range.side, line);
      if (!map.has(key)) {
        map.set(key, {
          isEnd: line === range.endLine,
          isStart: line === range.startLine,
        });
      }
    }
  }
  return map;
}

/** Multi-line spans for existing range comments, keyed off their start/end anchors. */
export function getInlineCommentRanges(
  threads: CommentThread[]
): InlineCommentRange[] {
  const ranges: InlineCommentRange[] = [];
  for (const { root } of threads) {
    const side = root.startSide ?? root.side;
    if (
      side &&
      root.startLine != null &&
      root.line != null &&
      root.startLine < root.line
    ) {
      ranges.push({ endLine: root.line, side, startLine: root.startLine });
    }
  }
  return ranges;
}
