import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";

/**
 * The filters of Desktop's combined Sessions list-and-usage read.
 *
 * `search` is the desktop-local hint the cloud routes never receive; the cloud
 * list route narrows by `listSearch` alone, which the view sets only under
 * `gridview-adoption` (ISS-13035).
 */
export function buildSessionsPageDataFilters<
  TFacets extends object,
  TComparison extends object,
>({
  comparison,
  endDate,
  facetQuery,
  listSearch,
  maxOffset,
  page,
  pageSize,
  search,
  sortDir,
  sortKey,
  startDate,
}: {
  comparison: TComparison;
  endDate: string | undefined;
  facetQuery: TFacets;
  listSearch: string | undefined;
  maxOffset: number | undefined;
  page: number;
  pageSize: number;
  search: string | undefined;
  sortDir: SessionSortDir;
  sortKey: SessionSortKey | null;
  startDate: string | undefined;
}) {
  const offset = page * pageSize;
  return {
    ...facetQuery,
    endDate,
    limit: pageSize,
    offset: maxOffset === undefined ? offset : Math.min(offset, maxOffset),
    search,
    listSearch,
    startDate,
    ...(sortKey ? { sortBy: sortKey, sortDir } : {}),
    ...comparison,
  };
}
