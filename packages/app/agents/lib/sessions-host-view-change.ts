import type { DateRange } from "../../shared/lib/format-utils";
import type { SessionFacetFilters } from "./session-filter-adapter";
import type { SessionGroupBy } from "./session-grouping";
import type {
  SessionSortDir,
  SessionSortKey,
  SessionSortRule,
} from "./session-sort-group";
import type { SessionsHostViewState } from "./sessions-list-view-adapter";

/**
 * ISS-8909 — how a Sessions HOST applies one `SessionsListSurfaceV2` view
 * update, for every shell that mounts that surface.
 *
 * Lifted out of the web page's `sessions-page-scope.ts` when the desktop
 * renderer became a second host. The routing is not shell-specific — which axes
 * moved, and in what ORDER their writes have to land, is a property of the
 * surface's controller contract — so a second hand-written copy in
 * `apps/desktop` would be two implementations of one ordering rule, drifting
 * silently the first time either shell fixed a bug in it.
 */

/** One settled scope move; `null` on an axis means it did not move. */
export type SessionsScopeDelta = {
  clearScopeUser: boolean;
  dateRange: DateRange | null;
  facets: SessionFacetFilters;
  /** The new term (`""` clears it), or `null` when the term did not move. */
  search: string | null;
};

/**
 * ISS-7052 Part A — which of the SCOPE axes a v2 surface update moved, as the
 * single write that applies them.
 *
 * `null` when none moved. `dateRange: null` inside the delta means the window
 * did NOT move, which is what tells the caller to leave an inbound `?range=` /
 * `?from=` / `?to=` alone — a facet-only change must not strip a window the
 * reader arrived with. `clearScopeUser` reads the same way for `?userId=`.
 *
 * Answered here rather than inline because the axes have to move in ONE history
 * write: the v2 toolbar's "Clear all" changes all three at once, and separate
 * writes all copy the same pre-click search-params snapshot, so the facet write
 * puts back the window params the range write removed (the ISS-4728 trap
 * `handleDateRangeChange` and `handleFiltersChange` each already document).
 *
 * ISS-8037 adds the owner scope to that set. Only a CLEAR is expressible: the
 * v2 surface's `removeOwnerScope` and its `clearAllFilters` both patch the axis
 * to `null` and nothing on the surface ever selects a scope, so a `next` that
 * still names one — or names a different one — moves nothing here rather than
 * stripping a param on a value the surface cannot have produced.
 */
export function resolveSessionsScopeDelta(
  next: {
    dateRange: DateRange;
    facets: SessionFacetFilters;
    scopeUserId: string | null;
    search?: string;
  },
  current: {
    dateRange: DateRange;
    facets: SessionFacetFilters;
    scopeUserId: string | null;
    search?: string;
  }
): SessionsScopeDelta | null {
  const windowMoved = next.dateRange !== current.dateRange;
  const facetsMoved = next.facets !== current.facets;
  const clearScopeUser =
    current.scopeUserId !== null && next.scopeUserId === null;
  // PRD-721: the toolbar search both sets and clears a term, so the host hears
  // the new term (possibly `""`) in the same single write as the other axes.
  const searchMoved = (next.search ?? "") !== (current.search ?? "");
  if (!(windowMoved || facetsMoved || clearScopeUser || searchMoved)) {
    return null;
  }
  return {
    clearScopeUser,
    dateRange: windowMoved ? next.dateRange : null,
    facets: facetsMoved ? next.facets : current.facets,
    search: searchMoved ? (next.search ?? "") : null,
  };
}

/**
 * Apply a whole visible-column SET onto a per-column toggle.
 *
 * Both directions, or hiding a column would stick and re-showing it would not.
 * Lifted out of the page's view-change handler because the loop and its nested
 * comparison are three of that callback's complexity points, and it is a pure
 * set diff that needs none of the component's other state.
 */
export function applySessionsColumnDiff(
  current: ReadonlySet<string>,
  next: ReadonlySet<string>,
  toggleColumn: (columnId: string) => void
): void {
  for (const id of new Set([...current, ...next])) {
    if (current.has(id) !== next.has(id)) {
      toggleColumn(id);
    }
  }
}

/**
 * ISS-7052 Part A — route ONE v2 surface update onto the host's existing
 * handlers, so the v2 path inherits every side effect the v1 controls carry.
 *
 * ORDER IS THE CONTRACT, not a style. The page branch is SKIPPED whenever a
 * scope write fired — the resolved delta's, or the one `pendingScopeClear`
 * synthesizes, which carries the same page reset: a scope change always resets
 * to page 0 and `onScopeChange` has already written that reset carrying the NEW
 * facets. A second write is the ISS-4728 / ISS-5355 trap the web page documents
 * twice — `replacePage` builds from the caller's pre-change facet state and both
 * writes copy the same pre-click search-params snapshot inside one commit, so
 * the later one wins and puts the just-cleared facets back. Clearing from page 4
 * left `?status=` in the URL after the UI said it had reset, and a reload
 * restored the wrong scope.
 */
export function applySessionsHostViewChange(
  next: SessionsHostViewState,
  current: {
    dateRange: DateRange;
    facets: SessionFacetFilters;
    groupBy: SessionGroupBy;
    pageIndex: number;
    scopeUserId: string | null;
    search?: string;
    secondarySorts: readonly SessionSortRule[];
    sortDir: SessionSortDir;
    sortKey: SessionSortKey | null;
    visibleColumns: ReadonlySet<string>;
  },
  handlers: {
    /**
     * ISS-8909: OPTIONAL, because it answers a question only a host with a
     * lagging page index has. The web page's `?page=` is written through an
     * async router replace, so it holds an effective-index override and this
     * marks it; the desktop renderer reads its page straight back out of the
     * hash URL it just wrote and has no such override to mark.
     */
    markPageReset?: () => void;
    onScopeChange: (delta: SessionsScopeDelta) => void;
    replacePage: (page: number) => void;
    setGroupBy: (groupBy: SessionGroupBy) => void;
    setSecondarySorts: (next: readonly SessionSortRule[]) => void;
    setSort: (sortKey: SessionSortKey | null, sortDir: SessionSortDir) => void;
    toggleColumn: (columnId: string) => void;
  },
  {
    /**
     * ISS-9822: the host is holding a clear for an axis this router does not
     * compare — an explicit `?from=`/`?to=` window — and the
     * surface update that carries it moved nothing else.
     */
    pendingScopeClear = false,
  }: { pendingScopeClear?: boolean } = {}
): void {
  // ISS-8335: the PRIMARY slot and the rules after it are two stores, so both
  // are compared — and either moving resets the page, because either changes
  // which rows page 1 holds. Comparing only the primary is what let a reader add
  // a second rule and stay on page 3 of an order that no longer existed.
  const secondaryMoved = !areSecondarySortsEqual(
    next.secondarySorts,
    current.secondarySorts
  );
  const primaryMoved =
    next.sortKey !== current.sortKey || next.sortDir !== current.sortDir;
  if (primaryMoved || secondaryMoved) {
    // `next.sortKey` may be null — the v2 toolbar can CLEAR the sort, which the
    // v1 headers cannot. Null is persisted as null so the query omits `sortBy`
    // and takes the server's default order; fabricating a column here would
    // silently re-sort a list the reader just un-sorted.
    handlers.markPageReset?.();
    if (primaryMoved) {
      handlers.setSort(next.sortKey, next.sortDir);
    }
    if (secondaryMoved) {
      // Written even when the list is EMPTY: clearing every rule but the lead
      // one is a change the reader made, and skipping the empty write would
      // leave the removed rules persisted and still ordering the next read.
      handlers.setSecondarySorts(next.secondarySorts);
    }
    handlers.replacePage(0);
  }
  if (next.groupBy !== current.groupBy) {
    handlers.setGroupBy(next.groupBy);
  }
  // ONE write for every scope axis — the window, the facets, and (ISS-8037) the
  // `?userId=` strip. See `resolveSessionsScopeDelta`.
  const scopeDelta = resolveSessionsScopeDelta(next, current);
  if (scopeDelta) {
    handlers.onScopeChange(scopeDelta);
  } else if (pendingScopeClear) {
    // Clearing ONLY a host-held axis moves none of the axes above, so nothing
    // would write the URL and the clear would never land. Synthesized as a
    // no-delta scope write so it rides the same single write every other clear
    // does: a second `replaceListParams` here would start from the same
    // pre-click snapshot and restore what the surface just cleared.
    handlers.onScopeChange({
      clearScopeUser: false,
      dateRange: null,
      facets: next.facets,
      search: null,
    });
  }
  const wroteScope = scopeDelta !== null || pendingScopeClear;
  applySessionsColumnDiff(
    current.visibleColumns,
    next.visibleColumns,
    handlers.toggleColumn
  );
  // Compared against the value the surface was HANDED, the EFFECTIVE index.
  // Against the URL's this misses a real move during an override window —
  // effective 0, URL still 3, reader clicks page 4 and `3 !== 3` swallows the
  // write — and fabricates one for any unrelated change made in that window.
  if (!wroteScope && next.page !== current.pageIndex) {
    // A reset to page 0 (a grouping change) is marked as the sort branch's is,
    // so the group link's URL write (ISS-12462) waits for this replace instead
    // of re-writing the pre-reset `?page=` from the same snapshot.
    if (next.page === 0) {
      handlers.markPageReset?.();
    }
    handlers.replacePage(next.page);
  }
}

/**
 * ISS-8335: do two secondary-sort lists describe the same order?
 *
 * Compared by VALUE, not identity. The surface rebuilds its rule array on every
 * report, so an identity check would call every unrelated change a sort move —
 * resetting the reader to page 1 whenever they toggled a column.
 */
function areSecondarySortsEqual(
  a: readonly SessionSortRule[],
  b: readonly SessionSortRule[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every(
    (rule, index) =>
      rule.fieldId === b[index]?.fieldId &&
      rule.direction === b[index]?.direction
  );
}
