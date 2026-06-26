import type { BranchCommit, MergedTraceItem } from "@repo/api/src/types/branch";

/**
 * Pure event-dot derivation (Epic E / E3). Maps the merged trace's `event` items
 * to colored outcome dots: `dot === "g"` (or commit/merge/success text) → green;
 * `dot === "r"` (or error/fail text) → red. The blue autonomy dot (`dot === "b"`)
 * is explicitly DROPPED per the AC — this function never emits blue. Orange PR-
 * comment dots are NOT produced here; they come from the live PR comment count at
 * the rail level (a separate, soft source).
 */
export type BranchEventDotColor = "green" | "red" | "orange";

export type BranchEventDot = {
  /** Trace row to jump to on click; `null` for lifecycle dots (no trace row). */
  row: number | null;
  t: string;
  color: BranchEventDotColor;
  label: string;
};

const RED_RE = /error|fail|reject|limit|timeout/i;
const GREEN_RE = /commit|merge|success|approv|pass|push|open/i;

export function deriveEventDots(
  items: readonly MergedTraceItem[]
): BranchEventDot[] {
  const dots: BranchEventDot[] = [];
  items.forEach((item, row) => {
    if (item.type !== "event" || item.dot === "b") {
      return;
    }
    const haystack = `${item.text} ${item.tag ?? ""}`;
    let color: BranchEventDotColor | null = null;
    if (item.dot === "r" || RED_RE.test(haystack)) {
      color = "red";
    } else if (item.dot === "g" || GREEN_RE.test(haystack)) {
      color = "green";
    }
    if (color) {
      dots.push({ row, t: item.t, color, label: item.text });
    }
  });
  return dots;
}

/**
 * Green lifecycle dots from the structured branch detail — the design's git-
 * lifecycle markers, which the agent trace never carries (`event` items are
 * session-internal). Sources (PRD-486): one dot per real commit (captured
 * event-time, positioned by `committedAt`, tooltip = subject), a PR-opened dot,
 * and the merge dot. Lifecycle dots have no trace row, so they render as
 * non-clickable markers positioned by their timestamp. (A closed-without-merge
 * dot is deferred: it has no design-blessed color/tooltip — red reads as a
 * failure — and was not part of the PRD's acceptance criteria.)
 */
export function deriveLifecycleDots(input: {
  mergedAt: string | null;
  prNumber: number | null;
  openedAt: string | null;
  commits: readonly BranchCommit[];
}): BranchEventDot[] {
  const dots: BranchEventDot[] = [];
  const isValidInstant = (t: string | null): t is string =>
    t != null && !Number.isNaN(Date.parse(t));

  // One green dot per real commit, positioned by its commit time; the subject is
  // the tooltip (fall back to the short SHA when no message was captured).
  for (const commit of input.commits) {
    if (!isValidInstant(commit.committedAt)) {
      continue;
    }
    dots.push({
      row: null,
      t: commit.committedAt,
      color: "green",
      label: commit.message || commit.sha.slice(0, 7),
    });
  }

  const prSuffix = input.prNumber == null ? "" : ` #${input.prNumber}`;

  // PR opened — green (the design colors an open PR green); distinct from the
  // merge/close dots by label and position.
  if (isValidInstant(input.openedAt)) {
    dots.push({
      row: null,
      t: input.openedAt,
      color: "green",
      label: `Opened${prSuffix}`,
    });
  }

  if (isValidInstant(input.mergedAt)) {
    dots.push({
      row: null,
      t: input.mergedAt,
      color: "green",
      label: `Merged${prSuffix}`,
    });
  }

  return dots;
}
