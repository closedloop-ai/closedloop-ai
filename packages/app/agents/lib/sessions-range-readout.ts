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
 * The upper bound is the rows ACTUALLY on screen, not `(page + 1) * pageSize`.
 * On the last page those differ, and asserting the arithmetic bound would claim
 * rows the reader cannot see.
 *
 * #4480 (wongk + stage): the readout also has to know when its OWN inputs
 * disagree. Both shells hold the list query with `keepPreviousData`, so on a
 * page click the page index moves immediately while `items` and `total` are
 * still the previous page's — jump from page 1 to page 10 of 240 and an
 * ungated readout says "Showing 226-240 of 240" over page 1's rows, and claims
 * 15 rows while 25 are rendered. The body has no such window because it just
 * re-renders the same rows; only a readout that ASSERTS a range can contradict
 * them. So the settled-ness is a required input, not a caller's discipline, and
 * an unsettled page returns `null` — no readout at all — rather than a range
 * that is about to be wrong. That also covers the bookmarked out-of-range page,
 * whose one paint before the clamp effect lands is exactly this state.
 */
import { formatNumber } from "@repo/app/shared/lib/format-utils";

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
  if (isPlaceholderPage) {
    return null;
  }
  const unit = total === 1 ? "session" : "sessions";
  if (total === 0 || rowsOnPage === 0) {
    return `Showing 0 of ${formatNumber(total)} ${unit}`;
  }
  const from = pageIndex * pageSize + 1;
  const to = Math.min(from + rowsOnPage - 1, total);
  return `Showing ${formatNumber(from)}-${formatNumber(to)} of ${formatNumber(total)} ${unit}`;
}
