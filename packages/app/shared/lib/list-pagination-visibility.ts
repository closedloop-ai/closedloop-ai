/**
 * ISS-9216 — the ONE rule deciding whether a v2 list surface renders its
 * paginator.
 *
 * Sessions and Branches each answered this question themselves, and Branches
 * answered it TWICE: `shouldShowBranchListV2Pagination` sat in
 * `branches/lib/branch-page-state.ts` and was called by the web page and the
 * desktop view — outside the component it governs — over a `showPagination`
 * boolean each host computed for itself. Three predicates in three places is
 * how the same data came to render a footer on one shell and none on the other.
 *
 * A host supplies the DATA below and nothing else; both surfaces call this and
 * neither takes a visibility prop, so a host has no expression left to disagree
 * with.
 */
export function shouldRenderListPagination({
  hasPageableRows,
  isGroupedClientSide,
  isPagingPlaceholder,
}: {
  /** Rows the reader can page through right now. */
  hasPageableRows: boolean;
  /**
   * The view groups client-side, so the GROUPS are the page unit and there is
   * nothing left to paginate. Checked first: a grouped view shows no footer
   * even mid-page, because there is no page for a placeholder to stand in for.
   */
  isGroupedClientSide: boolean;
  /**
   * A placeholder page is in flight. The footer stays mounted so paging does
   * not drop a row's worth of height and reflow the table above it — the
   * behaviour Branches shipped, now Sessions' too.
   */
  isPagingPlaceholder: boolean;
}): boolean {
  if (isGroupedClientSide) {
    return false;
  }
  return isPagingPlaceholder || hasPageableRows;
}
