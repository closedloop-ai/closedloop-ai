/**
 * Shared "which trace row is the reader on?" computation for the Session detail
 * and Branch detail timelines. As the user scrolls the page container, both
 * surfaces call this (rAF-throttled) to resolve the current row, which drives the
 * read-only "you are here" line and the active-row highlight.
 *
 * The current row is the last rendered `[data-row]` whose top has scrolled up
 * past the sticky header(s) — the lowest row at or above the fold. When nothing
 * has passed the fold yet (scrolled to the very top), it falls back to the FIRST
 * rendered row so the indicator resets to the start instead of sticking on a
 * stale deep row. Returns null only when there are no rows at all.
 */

export type ComputeActiveTraceRowOptions = {
  /** The scroll container being read. */
  scroller: HTMLElement | null;
  /** Where to look for `[data-row]` nodes; defaults to `scroller`. */
  root?: HTMLElement | null;
  /** Selector for row nodes (scoped to `root`); defaults to `[data-row]`. */
  rowSelector?: string;
  /** Sticky headers pinned at the top whose heights push the fold line down. */
  stickySelectors?: readonly string[];
  /** Extra gap below the sticky headers before a row counts as "passed". */
  gapPx?: number;
};

const DEFAULT_GAP_PX = 6;

export function computeActiveTraceRow({
  scroller,
  root,
  rowSelector = "[data-row]",
  stickySelectors = [],
  gapPx = DEFAULT_GAP_PX,
}: ComputeActiveTraceRowOptions): number | null {
  if (!scroller) {
    return null;
  }
  const searchRoot = root ?? scroller;
  let offset = gapPx;
  for (const selector of stickySelectors) {
    offset += scroller.querySelector<HTMLElement>(selector)?.offsetHeight ?? 0;
  }
  const foldTop = scroller.getBoundingClientRect().top + offset;

  let passedRow: number | null = null;
  let firstRow: number | null = null;
  let firstTop = Number.POSITIVE_INFINITY;
  for (const node of searchRoot.querySelectorAll<HTMLElement>(rowSelector)) {
    const value = Number(node.getAttribute("data-row"));
    if (Number.isNaN(value)) {
      continue;
    }
    const top = node.getBoundingClientRect().top;
    if (top < firstTop) {
      firstTop = top;
      firstRow = value;
    }
    if (top <= foldTop) {
      passedRow = value;
    }
  }
  // Scrolled to the top (nothing past the fold) → reset to the first row rather
  // than leaving the indicator on a stale deeper row.
  return passedRow ?? firstRow;
}
