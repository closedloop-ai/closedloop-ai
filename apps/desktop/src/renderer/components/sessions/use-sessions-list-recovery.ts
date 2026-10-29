import { SESSION_URL_OWNED_WINDOW_PARAMS } from "@repo/app/agents/lib/session-custom-date-window";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import { useLoadingStall } from "@repo/app/shared/hooks/use-loading-stall";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import type { LoadingStallPhase } from "@repo/app/shared/lib/loading-stall-phase";
import { useCallback, useEffect, useRef, useState } from "react";
import { SESSIONS_LIST_STALL_THRESHOLDS } from "./sessions-list-stall-thresholds";

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
 * - **Retry** rechecks the source and retries a failed read. A pending read
 *   keeps running and repeated clicks share the same replacement request.
 * - **Stall phase** reports elapsed loading time without claiming a failure.
 */
export function useSessionsListRecovery({
  cancelPageDataRead,
  isBlockingLoad,
  isListScopeDefault,
  isPageDataFetching,
  setFacetFilters,
  setDateRange,
  replaceListParams,
  searchParam,
  recheckLocalSource,
  refetchPageData,
}: {
  /**
   * Cancel the EXACT in-flight list read (ISS-7249, whitlockk review). Fired, not
   * awaited: `cancelQueries` dispatches synchronously and batches its
   * notification, so the refetch below joins the same commit and the table never
   * flashes an idle frame between the two.
   */
  cancelPageDataRead: () => void;
  isBlockingLoad: boolean;
  /**
   * Whether the list scope is ALREADY at defaults — no facets, default range, no
   * search term, first page. A reset from there changes no query key, so nothing
   * would refetch and nothing would settle (ISS-7249, whitlockk review).
   */
  isListScopeDefault: boolean;
  /** The list read's live fetch state, which is what settles a reset (ISS-7249). */
  isPageDataFetching: boolean;
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
  // Read at press time, not captured in a dep array: both handlers are handed to
  // the tracked-telemetry wrapper, and re-creating them on every filter or
  // fetch-state change would churn the wrapper's identity for no behaviour.
  const isListScopeDefaultRef = useRef(isListScopeDefault);
  isListScopeDefaultRef.current = isListScopeDefault;
  const cancelPageDataReadRef = useRef(cancelPageDataRead);
  cancelPageDataReadRef.current = cancelPageDataRead;

  const handleClearFilters = useCallback(() => {
    setFacetFilters(DEFAULT_SESSION_FACET_FILTERS);
    setDateRange(DEFAULT_DATE_RANGE);
    // Strip the URL-owned `?search=` term — the facet writer doesn't manage it,
    // so without this the copied snapshot would preserve the search that produced
    // the empty/failed result and "Clear filters" would re-run it (FEA-4181).
    //
    // FEA-4201 adds every URL-OWNED WINDOW param to that set for the same
    // reason: they are URL-owned, they count toward `hasActiveSessionFilters`,
    // and leaving one behind would "clear" straight back to the same narrowed
    // rows. `?range=` is in the set even though this shell never reads it — an
    // inbound link's `range=90d` that Clear declines to strip survives in a URL
    // this shell then hands on, and narrows the listing for whoever opens it on
    // web. Same set as the web page, from one shared constant, so the two
    // surfaces cannot clear a different amount of the same window.
    replaceListParams(DEFAULT_SESSION_FACET_FILTERS, 0, [
      searchParam,
      ...SESSION_URL_OWNED_WINDOW_PARAMS,
    ]);
  }, [replaceListParams, searchParam, setDateRange, setFacetFilters]);

  /*
   * ISS-7249 (review cids 3818119802 / 3821326374): the errored empty's recovery
   * Link is the retry affordance for the unavailable/fetch_failed treatment —
   * `ErroredEmpty` prefers it over the standalone Retry button, so it is the ONE
   * thing the user can click there. Tracking it needs an awaitable, and the
   * reset deliberately has no `refetch()` to await: the reload is the query-key
   * change. So the read's own fetch state is the settle signal.
   *
   * Resolving on the click instead would report a recovery the instant it was
   * pressed, before any read answered — the confident wrong number this ticket
   * exists to stop. `sawFetch` is why the two branches differ: normally the key
   * change starts a fetch and the reset settles when it finishes, but a reset
   * that answers from cache never sets `isPageDataFetching`, and waiting for a
   * fetch that will not come would strand the attempt with no settled sibling.
   * One elapsed commit with no fetch in sight means the read was already
   * answered, which is a real settle rather than a timeout.
   */
  const pendingResetRef = useRef<PendingReset | null>(null);
  useEffect(() => {
    const pending = pendingResetRef.current;
    if (pending === null) {
      return;
    }
    pending.commits += 1;
    if (isPageDataFetching) {
      pending.sawFetch = true;
      return;
    }
    if (pending.sawFetch || pending.commits > 1) {
      pendingResetRef.current = null;
      pending.resolve();
    }
  });

  /*
   * ISS-7249 (whitlockk review): the settle machinery above waits on a commit the
   * reset only produces when it CHANGES something. Pressed from the already-
   * clean key — the unavailable treatment on an unfiltered first page, which is
   * the common case — every setter writes the value it already held, React bails
   * out of the re-render, no query key moves, no fetch starts, and the promise
   * pends forever with `retry_settled` never arriving.
   *
   * Of the two remedies whitlockk offered, this takes the second: explicitly refetch
   * the unchanged key. It is also the one that makes the control honest — the
   * Link says "Clear filters and reload", and with nothing to clear the reload
   * IS the whole action, so a press that started and ended no read was doing
   * nothing at all. Refetching the pre-clear key is only wrong when there are
   * filters to escape, and that branch is untouched.
   */
  const handleClearFiltersAndReload = useCallback(() => {
    const wasAlreadyDefault = isListScopeDefaultRef.current;
    handleClearFilters();
    if (wasAlreadyDefault) {
      cancelPageDataReadRef.current();
      return refetchPageData().then(
        () => undefined,
        () => undefined
      );
    }
    return new Promise<void>((resolve) => {
      // A second press inherits the first's wait rather than replacing it, so a
      // superseded reset cannot be left permanently unsettled.
      const superseded = pendingResetRef.current;
      pendingResetRef.current = {
        commits: 0,
        resolve: () => {
          superseded?.resolve();
          resolve();
        },
        sawFetch: false,
      };
    });
  }, [handleClearFilters, refetchPageData]);

  const [retryToken, setRetryToken] = useState(0);
  // Retry a failed request without cancelling or duplicating a pending read.
  const retryInFlight = useRef<Promise<unknown> | null>(null);
  const handleRetry = useCallback(() => {
    if (retryInFlight.current) {
      return retryInFlight.current;
    }
    if (isBlockingLoad || isPageDataFetching) {
      return Promise.resolve();
    }
    recheckLocalSource();
    setRetryToken((token) => token + 1);
    // Issued SYNCHRONOUSLY, not off a microtask: the press is the read's cause,
    // and deferring it by a tick means a caller that observes the handler's
    // effect in the same turn — the errored empty's recovery wiring, and the
    // dead-end telemetry wrapper around it — sees no read at all.
    const pending = Promise.resolve(refetchPageData()).catch(() => undefined);
    retryInFlight.current = pending;
    return pending.finally(() => {
      retryInFlight.current = null;
    });
  }, [isBlockingLoad, isPageDataFetching, recheckLocalSource, refetchPageData]);

  const stallPhase = useLoadingStall(
    isBlockingLoad,
    SESSIONS_LIST_STALL_THRESHOLDS,
    retryToken
  );

  return {
    handleClearFilters,
    handleClearFiltersAndReload,
    handleRetry,
    stallPhase,
  };
}

/** One reset waiting on the read its filter change kicked off. */
type PendingReset = { commits: number; resolve: () => void; sawFetch: boolean };

export type SessionsListRecovery = {
  handleClearFilters: () => void;
  /**
   * The same reset, resolving when the read it triggered has settled, so the
   * errored empty's recovery Link can be tracked as the retry it is (ISS-7249).
   */
  handleClearFiltersAndReload: () => Promise<void>;
  /** Resolves when the retry's own read has settled (ISS-7249). */
  handleRetry: () => Promise<unknown>;
  stallPhase: LoadingStallPhase;
};
