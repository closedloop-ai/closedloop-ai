import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { useCallback, useState } from "react";
import {
  type LoadingStallPhase,
  useLoadingStall,
} from "../../hooks/use-loading-stall";
import { SESSIONS_LIST_STALL_THRESHOLDS } from "./sessions-table-body";

/**
 * ISS-4534 / FEA-3639: the desktop Sessions-list recovery concern, extracted from
 * `SessionsView` so that grandfathered file finishes smaller.
 *
 * Owns the three cohesive recovery affordances of a failed/wedged list load:
 *
 * - **Clear filters** ({@link SessionsListRecovery.handleClearFilters}) — resets
 *   the view's facet + date state to defaults and strips the URL-owned `?search=`
 *   term, so the query-key change re-issues the read against the unfiltered scope
 *   (the honest "reload" behind the errored empty's recovery Link). It does NOT
 *   `refetch()` the pre-clear key, which would re-run the failing narrowed scope.
 * - **Retry** ({@link SessionsListRecovery.handleRetry}) — for the hard-stall
 *   "temporarily unavailable" state: re-polls the local source AND bumps the
 *   stall token so the detector re-arms its soft/hard budget (a wedged read keeps
 *   `isBlockingLoad` latched, so the token is the only thing that restarts the
 *   timers), then re-runs the read. `refetch()` already replaces an in-flight
 *   fetch (query-core defaults `cancelRefetch` to true), so no explicit option.
 * - **Stall phase** ({@link SessionsListRecovery.stallPhase}) — the soft/hard
 *   escalation the token feeds, so a blocking load never sits on an infinite
 *   skeleton.
 */
export function useSessionsListRecovery({
  isBlockingLoad,
  setFacetFilters,
  setDateRange,
  replaceListParams,
  searchParam,
  recheckLocalSource,
  refetchPageData,
}: {
  isBlockingLoad: boolean;
  setFacetFilters: (filters: SessionFacetFilters) => void;
  setDateRange: (range: DateRange) => void;
  replaceListParams: (
    filters: SessionFacetFilters,
    page: number,
    extraParamsToStrip?: readonly string[]
  ) => void;
  searchParam: string;
  recheckLocalSource: () => void;
  refetchPageData: () => Promise<unknown>;
}): SessionsListRecovery {
  const handleClearFilters = useCallback(() => {
    setFacetFilters(DEFAULT_SESSION_FACET_FILTERS);
    setDateRange(DEFAULT_DATE_RANGE);
    // Strip the URL-owned `?search=` term — the facet writer doesn't manage it,
    // so without this the copied snapshot would preserve the search that produced
    // the empty/failed result and "Clear filters" would re-run it (FEA-4181).
    replaceListParams(DEFAULT_SESSION_FACET_FILTERS, 0, [searchParam]);
  }, [replaceListParams, searchParam, setDateRange, setFacetFilters]);

  const [retryToken, setRetryToken] = useState(0);
  const handleRetry = useCallback(() => {
    recheckLocalSource();
    setRetryToken((token) => token + 1);
    refetchPageData().catch(() => undefined);
  }, [recheckLocalSource, refetchPageData]);

  const stallPhase = useLoadingStall(
    isBlockingLoad,
    SESSIONS_LIST_STALL_THRESHOLDS,
    retryToken
  );

  return { handleClearFilters, handleRetry, stallPhase };
}

export type SessionsListRecovery = {
  handleClearFilters: () => void;
  handleRetry: () => void;
  stallPhase: LoadingStallPhase;
};
