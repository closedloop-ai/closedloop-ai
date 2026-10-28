/**
 * ISS-9216 — the ONE range a v2 list surface's footer reads out, and the ONE
 * state in which it says nothing.
 *
 * `shouldRenderListPagination` took the footer's VISIBILITY away from the hosts;
 * this takes its SENTENCE. `paginationReadout` was the seam left behind: an
 * opaque `ReactNode` four hosts each filled differently — web Sessions off
 * `effectivePageIndex`, desktop Sessions off `page`, both Branches hosts off a
 * bare `from–to of total` with no suppression at all — and a fifth answer, the
 * surface's own fallback, that matched none of them. Nothing could fail, because
 * a `ReactNode` says nothing about which page it describes.
 *
 * Both surfaces call this and neither takes a readout prop, so there is no
 * expression left for a host to disagree with. The COPY still differs (Sessions
 * announces a sentence with the unit, Branches states the terse range) because
 * that is each surface's shipped wording, not a pagination decision.
 */

/**
 * The 1-based, inclusive range of rows on screen, or `null` when the surface
 * must not state one.
 *
 * `pageIndex` MUST be the same index the caller hands `TablePaginationFooter`'s
 * `page` — `safePage` in Sessions (the CLAMPED index, which is the page the
 * rows actually came from, not the out-of-range one a bookmark named),
 * `page` in Branches. The readout and the pager are one control: an index that
 * disagrees with the one the buttons are counting from is a sentence about a
 * different page than the reader is looking at, which is the whole defect class
 * the three host-side indexes above were an instance of.
 *
 * The upper bound is the rows ACTUALLY rendered, never `(pageIndex + 1) *
 * pageSize`: on the last page — or any short page a server trimmed — the
 * arithmetic bound claims rows the reader cannot see.
 */
export function listPageRange({
  isPagingPlaceholder,
  pageIndex,
  pageSize,
  rowsOnPage,
  total,
}: {
  /**
   * The rendered rows are NOT the page `pageIndex` names — a placeholder page
   * held by `keepPreviousData`, a read still in flight, or an out-of-range page
   * awaiting its clamp. One rule, and it suppresses rather than guesses: the
   * body has no such window because it re-renders the same rows, and only a
   * readout that ASSERTS a range can contradict them (#4480).
   */
  isPagingPlaceholder: boolean;
  /** Zero-based index of the page on screen. */
  pageIndex: number;
  pageSize: number;
  /** Rows rendered on this page. */
  rowsOnPage: number;
  /** Total matching rows, as reported by the list read. */
  total: number;
}): ListPageRange | null {
  if (isPagingPlaceholder) {
    return null;
  }
  if (total === 0 || rowsOnPage === 0) {
    return { from: 0, to: 0 };
  }
  const from = pageIndex * pageSize + 1;
  return { from, to: Math.min(from + rowsOnPage - 1, total) };
}

/**
 * ISS-9225: named so the ONE footer both surfaces render can hand each surface's
 * own sentence the range it derived, instead of taking a `ReactNode` back.
 */
export type ListPageRange = { from: number; to: number };
