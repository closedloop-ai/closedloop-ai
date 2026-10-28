/**
 * ISS-5315 — the Sessions list's pagination readout.
 *
 * The prototype's footer states the visible range and the total ("1–25 of 240")
 * beside the page controls; production shipped controls with no readout because
 * ISS-4681 recorded that this list "has no settled total it could state
 * honestly". It does now: the list response carries `total`, and the page
 * already derives `totalPages` from it — the readout was simply never wired.
 *
 * The phrasing follows the repo's existing footer sentence rather than the
 * prototype's bare "1–25 of 240", because `TablePaginationFooter` announces the
 * readout through a `role="status"` live region: a screen-reader user paging
 * through gets a sentence, not three numbers.
 *
 * ISS-9216: the RANGE and the state that suppresses it are `listPageRange`'s,
 * shared with Branches — this module is the Sessions SENTENCE over it and
 * nothing else. What that helper decides, and why an unsettled page states no
 * range at all rather than one that is about to be wrong (#4480), is documented
 * there.
 */
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import {
  type ListPageRange,
  listPageRange,
} from "@repo/app/shared/lib/list-pagination-readout";

/**
 * "Showing 1-25 of 240 sessions" for the current page, or `null` when the page
 * on screen is not the page the index names — see the module note.
 */
export function sessionsRangeReadout({
  pageIndex,
  pageSize,
  rowsOnPage,
  total,
  isPlaceholderPage = false,
}: {
  /** Zero-based page index. */
  pageIndex: number;
  pageSize: number;
  /** Rows rendered on this page. */
  rowsOnPage: number;
  /** Total matching sessions, as reported by the list read. */
  total: number;
  /**
   * The rendered rows are the PREVIOUS page's, kept on screen by
   * `keepPreviousData` while the page named by `pageIndex` loads. Required from
   * any caller whose query keeps previous data.
   */
  isPlaceholderPage?: boolean;
}): string | null {
  const range = listPageRange({
    isPagingPlaceholder: isPlaceholderPage,
    pageIndex,
    pageSize,
    rowsOnPage,
    total,
  });
  return range ? sessionsRangeSentence(range, total) : null;
}

/**
 * ISS-9225: the sentence alone, over a range `ListSurfacePaginationFooter` has
 * already derived. The v2 surface reads this so the footer that renders it and
 * the pager beside it describe one page; the v1 desktop view still calls
 * {@link sessionsRangeReadout}, which derives that range the same way.
 */
export function sessionsRangeSentence(
  { from, to }: ListPageRange,
  total: number
): string {
  const unit = total === 1 ? "session" : "sessions";
  if (to === 0) {
    return `Showing 0 of ${formatNumber(total)} ${unit}`;
  }
  return `Showing ${formatNumber(from)}-${formatNumber(to)} of ${formatNumber(total)} ${unit}`;
}
