import type { SortDirection } from "@closedloop-ai/design-system/components/ui/sortable-column-header";
import {
  type SessionsListParamsReplacer,
  useSessionsListUrlWriters as useSharedSessionsListUrlWriters,
} from "@repo/app/agents/hooks/use-sessions-list-url-writers";
import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { useCallback } from "react";

/**
 * The desktop Sessions view's own list-URL writers: the shared ones, plus the
 * two things that are this shell's and stay this shell's.
 *
 * ISS-9555 slice 4 moved the facet, window and page writes into
 * `@repo/app/agents/hooks/use-sessions-list-url-writers`, which the web page
 * mounts too — that module carries the ISS-4728 one-write-per-handler contract.
 * What could not move is the `?search=` term (the web page has no search param)
 * and `handleSort` (the web page's sort handler marks a page reset this shell
 * has no override for).
 */
export type SessionsListUrlWriters = {
  handleCustomDateWindowChange: (next: SessionCustomDateWindow | null) => void;
  handleDateRangeChange: (next: DateRange) => void;
  handleFiltersChange: (next: SessionFacetFilters) => void;
  /**
   * ISS-9107: the v2 surface reports every scope axis it moved as ONE settled
   * view, so the window, the facets and the search term are written together.
   * The v1 headers reach the URL through the narrower handlers above.
   */
  handleScopeChange: (delta: {
    /** ISS-9107: drop the explicit `?from=`/`?to=` window in this same write. */
    clearWindow: boolean;
    dateRange: DateRange | null;
    facets: SessionFacetFilters;
    /** PRD-721: the new `?search=` term (`""` clears it), or `null` unmoved. */
    search: string | null;
  }) => void;
  handleSort: (column: string, direction: SortDirection) => void;
  setPage: (nextPage: number) => void;
};

export function useSessionsListUrlWriters({
  facetFilters,
  replaceListParams,
  searchParam,
  setDateRange,
  setFacetFilters,
  setSort,
}: {
  facetFilters: SessionFacetFilters;
  replaceListParams: SessionsListParamsReplacer;
  /** The URL key the sidebar writes its term to, cleared by the v2 chip. */
  searchParam: string;
  setDateRange: (next: DateRange) => void;
  setFacetFilters: (next: SessionFacetFilters) => void;
  setSort: (sortKey: SessionSortKey | null, sortDir: SessionSortDir) => void;
}): SessionsListUrlWriters {
  const {
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleScopeChange: writeScopeChange,
    replacePage: setPage,
  } = useSharedSessionsListUrlWriters({
    facetFilters,
    replaceListParams,
    setDateRange,
    setFacetFilters,
  });

  const handleSort = useCallback(
    (column: string, direction: SortDirection) => {
      setSort(column as SessionSortKey, direction as SessionSortDir);
      setPage(0);
    },
    [setPage, setSort]
  );

  const handleScopeChange = useCallback(
    ({
      clearWindow,
      dateRange,
      facets,
      search,
    }: {
      clearWindow: boolean;
      dateRange: DateRange | null;
      facets: SessionFacetFilters;
      search: string | null;
    }) => {
      // The window params go when the preset moves (an explicit window
      // supersedes a preset, so picking one must not leave the old window
      // narrowing the read) and when the reader cleared filters. Not on a bare
      // facet toggle, which the v1 branch also leaves the window alone for.
      writeScopeChange({
        clearParamKeys: [],
        clearWindow,
        dateRange,
        facets,
        search: search === null ? null : { param: searchParam, value: search },
      });
    },
    [searchParam, writeScopeChange]
  );

  return {
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleScopeChange,
    handleSort,
    setPage,
  };
}
