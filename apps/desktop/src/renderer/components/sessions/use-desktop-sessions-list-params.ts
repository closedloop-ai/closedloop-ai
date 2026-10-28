import type { SessionsListParamsReplacer } from "@repo/app/agents/hooks/use-sessions-list-url-writers";
import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import { writeSessionFacetFilterParams } from "@repo/app/agents/lib/session-filter-adapter";
import type {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { useReplaceListParams } from "@repo/app/shared/hooks/use-replace-list-params";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { useCallback } from "react";
import { writeDesktopSessionsPage } from "./sessions-view-url-state";
import {
  type SessionsListUrlWriters,
  useSessionsListUrlWriters,
} from "./use-sessions-list-url-writers";

/**
 * Everything the desktop Sessions view writes to the list URL, composed once.
 *
 * `SessionsView` held this inline and reached the file-size ceiling with it
 * (ISS-9567). It is one responsibility and reads as one: a page write that knows
 * this shell's page-size staging, the shared facet/window/search writers over
 * it, and the page-size change that has to re-write page 0 so a larger page does
 * not leave the reader on an offset that no longer exists.
 *
 * The page-size trio (`settlePageSizeWrite`, `stagePageSizeChange`,
 * `writePageWithPageSize`) arrives as parameters rather than being read here:
 * `useSessionsPageSizeUrlState` is one hook whose `selectedPageSize` the view
 * needs for its own reads, and mounting it twice would give the two copies
 * separate staging state.
 */
export function useDesktopSessionsListParams({
  effectivePageSize,
  facetFilters,
  page,
  searchParam,
  setDateRange,
  setFacetFilters,
  setSort,
  settlePageSizeWrite,
  stagePageSizeChange,
  writePageWithPageSize,
}: {
  effectivePageSize: number;
  facetFilters: SessionFacetFilters;
  page: number;
  /** The URL key the sidebar writes its term to, cleared by the v2 chip. */
  searchParam: string;
  setDateRange: (next: DateRange) => void;
  setFacetFilters: (next: SessionFacetFilters) => void;
  setSort: (sortKey: SessionSortKey | null, sortDir: SessionSortDir) => void;
  settlePageSizeWrite: () => void;
  stagePageSizeChange: (nextPageSize: number) => void;
  writePageWithPageSize: (
    params: URLSearchParams,
    pageIndex: number,
    pageSize: number
  ) => void;
}): SessionsListUrlWriters & {
  handlePageSizeChange: (nextPageSize: number) => void;
  /** Re-exported because the view still writes the page directly on a few paths. */
  replaceListParams: SessionsListParamsReplacer;
} {
  // FEA-3560: one shared writer for every list-URL write. It re-asserts the
  // facet params on each call (from the filters argument), so a pagination or
  // sort click landing right after a facet change cannot copy a stale snapshot
  // and silently drop the facets from the hash URL.
  const writePageForCurrentSurface = useCallback(
    (params: URLSearchParams, pageIndex: number) =>
      writeDesktopSessionsPage({
        effectivePageSize,
        pageIndex,
        params,
        writePageWithPageSize,
      }),
    [effectivePageSize, writePageWithPageSize]
  );
  const replaceListParamsBase = useReplaceListParams(
    writeSessionFacetFilterParams,
    writePageForCurrentSurface
  );
  const replaceListParams = useCallback(
    (
      filters: SessionFacetFilters,
      pageIndex?: number,
      clearParamKeys?: readonly string[],
      writeExtraParams?: (params: URLSearchParams) => void
    ) => {
      try {
        replaceListParamsBase(
          filters,
          pageIndex,
          clearParamKeys,
          writeExtraParams
        );
      } finally {
        settlePageSizeWrite();
      }
    },
    [replaceListParamsBase, settlePageSizeWrite]
  );
  const writers = useSessionsListUrlWriters({
    facetFilters,
    replaceListParams,
    searchParam,
    setDateRange,
    setFacetFilters,
    setSort,
  });
  const handlePageSizeChange = useCallback(
    (nextPageSize: number) => {
      stagePageSizeChange(nextPageSize);
      if (page === 0) {
        replaceListParams(facetFilters, 0);
      }
    },
    [facetFilters, page, replaceListParams, stagePageSizeChange]
  );

  return { ...writers, handlePageSizeChange, replaceListParams };
}
