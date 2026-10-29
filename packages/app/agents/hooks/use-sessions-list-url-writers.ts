"use client";

import { useCallback } from "react";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  SESSION_URL_OWNED_WINDOW_PARAMS,
  type SessionCustomDateWindow,
  writeSessionCustomDateWindowParams,
} from "../lib/session-custom-date-window";
import type { SessionFacetFilters } from "../lib/session-filter-adapter";

/**
 * Every write a Sessions HOST makes to its own list URL that is not
 * host-specific, in one place — the shared half of the two
 * `use-sessions-list-url-writers.ts` twins ISS-9555 slice 4 collapsed.
 *
 * THE HAZARD IS WHY THEY ARE TOGETHER, and why they are shared.
 * `useReplaceListParams` copies the search-params snapshot React handed this
 * render, so two `replace` calls in one interaction both start from the
 * PRE-interaction URL and the later one wins — restoring whatever the earlier
 * one removed. Every handler here therefore performs exactly ONE
 * `replaceListParams`, carrying all of its narrowers together: the facets, the
 * page reset, the window params it must strip, and whichever host-owned scope
 * key the caller named. Splitting any one of them into two writes is the defect
 * the web page has now shipped and fixed three times — ISS-4728, review cid
 * 3701353686, and the ISS-7052 "Clear all" that left `?range=` behind — and it
 * was fixed on one host at a time for as long as there were two copies.
 *
 * `useCallback` throughout: each host's v2 controlled-view memo closes over
 * these, so a fresh closure per render would churn that memo on every unrelated
 * state change in the host component.
 */

export type SessionsListParamsReplacer = (
  filters: SessionFacetFilters,
  pageIndex?: number,
  clearParamKeys?: readonly string[],
  writeExtraParams?: (params: URLSearchParams) => void
) => void;

/** One settled scope move, as the single URL write that applies it. */
export type SessionsListScopeWrite = {
  /**
   * The host-owned narrower keys this move strips, already decided by the host:
   * the web page's `?userId=` scope, the desktop shell's `?search=` term. Empty
   * when the host's own axis did not move — a facet-only change must leave a
   * narrower the reader arrived with alone.
   */
  clearParamKeys: readonly string[];
  /**
   * Strip the URL-owned window params even though the PRESET did not move.
   * ISS-9107: "Clear filters" reports `dateRange: null` whenever the preset was
   * already the default, and without this the reader kept an explicit
   * `?from=`/`?to=` window narrowing a list they had just cleared.
   */
  clearWindow: boolean;
  /** `null` means the window did not move; see {@link clearWindow}. */
  dateRange: DateRange | null;
  facets: SessionFacetFilters;
  /**
   * PRD-721: the host's search term moved to `value` (`""` removes the param).
   * Written in this same single write; `null`/absent leaves the URL's term alone.
   */
  search?: { param: string; value: string } | null;
};

export type SessionsListUrlWriters = {
  handleCustomDateWindowChange: (next: SessionCustomDateWindow | null) => void;
  handleDateRangeChange: (next: DateRange) => void;
  handleFiltersChange: (next: SessionFacetFilters) => void;
  handleScopeChange: (write: SessionsListScopeWrite) => void;
  replacePage: (pageIndex: number) => void;
};

/**
 * Write a page index into the list URL, re-asserting the active facets with it.
 *
 * Its own hook because the web page needs it BEFORE it builds the rest of the
 * writers — its clamp effect and its page-size handler both call it — while the
 * desktop shell reaches it as `setPage` off {@link useSessionsListUrlWriters}.
 */
export function useSessionsReplacePage(
  replaceListParams: SessionsListParamsReplacer,
  facetFilters: SessionFacetFilters
): (pageIndex: number) => void {
  return useCallback(
    (pageIndex: number) => replaceListParams(facetFilters, pageIndex),
    [facetFilters, replaceListParams]
  );
}

export function useSessionsListUrlWriters({
  facetFilters,
  markPageReset,
  replaceListParams,
  setDateRange,
  setFacetFilters,
}: {
  /** The host's facet state, as the window writers must re-assert it. */
  facetFilters: SessionFacetFilters;
  /**
   * ISS-8909: OPTIONAL, because it answers a question only a host with a lagging
   * page index has. The web page's `?page=` is written through an async router
   * replace, so it holds an effective-index override these resets must mark; the
   * desktop renderer reads its page straight back out of the hash URL it just
   * wrote and has no such override.
   */
  markPageReset?: () => void;
  replaceListParams: SessionsListParamsReplacer;
  setDateRange: (next: DateRange) => void;
  setFacetFilters: (next: SessionFacetFilters) => void;
}): SessionsListUrlWriters {
  const replacePage = useSessionsReplacePage(replaceListParams, facetFilters);

  const handleFiltersChange = useCallback(
    (next: SessionFacetFilters) => {
      markPageReset?.();
      setFacetFilters(next);
      replaceListParams(next, 0);
    },
    [markPageReset, replaceListParams, setFacetFilters]
  );

  const handleDateRangeChange = useCallback(
    (next: DateRange) => {
      markPageReset?.();
      setDateRange(next);
      // ISS-5355 / FEA-4201: strip the URL-owned window in the SAME write as the
      // page reset. Two writes would both copy the pre-click params snapshot and
      // the second would restore what the first removed (the ISS-4728 trap),
      // leaving an inbound window overriding the preset the reader just picked.
      replaceListParams(facetFilters, 0, SESSION_URL_OWNED_WINDOW_PARAMS);
    },
    [facetFilters, markPageReset, replaceListParams, setDateRange]
  );

  const handleCustomDateWindowChange = useCallback(
    (next: SessionCustomDateWindow | null) => {
      markPageReset?.();
      // The window rides the SAME params snapshot as the page reset, and clears
      // `?range=` so an inbound preset cannot re-narrow the rows behind it.
      replaceListParams(
        facetFilters,
        0,
        SESSION_URL_OWNED_WINDOW_PARAMS,
        (params) => writeSessionCustomDateWindowParams(params, next)
      );
    },
    [facetFilters, markPageReset, replaceListParams]
  );

  const handleScopeChange = useCallback(
    ({
      clearParamKeys,
      clearWindow,
      dateRange: nextDateRange,
      facets,
      search,
    }: SessionsListScopeWrite) => {
      markPageReset?.();
      setFacetFilters(facets);
      if (nextDateRange !== null) {
        setDateRange(nextDateRange);
      }
      const setSearch =
        search && search.value !== ""
          ? (params: URLSearchParams) => params.set(search.param, search.value)
          : undefined;
      replaceListParams(
        facets,
        0,
        [
          ...clearParamKeys,
          ...(search?.value === "" ? [search.param] : []),
          ...(clearWindow || nextDateRange !== null
            ? SESSION_URL_OWNED_WINDOW_PARAMS
            : []),
        ],
        setSearch
      );
    },
    [markPageReset, replaceListParams, setDateRange, setFacetFilters]
  );

  return {
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleScopeChange,
    replacePage,
  };
}
