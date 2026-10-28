import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import {
  isSessionsListReadPending,
  SessionsListReadState,
} from "@repo/app/agents/lib/sessions-list-read-state";

/**
 * The desktop Sessions view's read-shape helpers, extracted from `SessionsView`
 * when FEA-4201's explicit-window wiring pushed that file back over the
 * 1,000-line ceiling. Both are pure and neither touches React, so they belong
 * beside the view rather than inside it.
 */

/**
 * The shared facet query fields the list and summary-usage reads both carry.
 * Extracted so the two call sites stay in lockstep and the component body avoids
 * duplicating the facet spread.
 */
export function buildFacetQuery(facetFilters: SessionFacetFilters) {
  // FEA-4192: `quality` is deliberately omitted, so the read fails open to `all`
  // (`coerceSessionQuality`). This is load-bearing for the summary row: desktop
  // can only quality-gate the Sessions COUNT, not the all-quality token/cost
  // cards, so a non-`all` segment would split the row across two populations
  // (gated count beside an all-quality token denominator). Pinning `all` keeps
  // all three cards on ONE population on screen. A future quality toggle here must
  // also caption the token/cost cards on their own basis — see
  // `getSharedAgentSessionsPageData` in shared-agent-sessions-api.ts.
  return {
    statuses: facetFilters.statuses,
    userIds: facetFilters.userIds,
    repositories: facetFilters.repositories,
    harnesses: facetFilters.harnesses,
    models: facetFilters.models,
    autonomyTiers: facetFilters.autonomyTiers,
    costBuckets: facetFilters.costBuckets,
    changePresence: facetFilters.changePresence,
    prAssociation: facetFilters.prAssociation,
  };
}

export function getMetricDataRefreshingState({
  canFetchAuxiliaryData,
  hasData,
  isError,
  isFetching,
  isPlaceholderData,
}: {
  canFetchAuxiliaryData: boolean;
  hasData: boolean;
  isError: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
}): boolean {
  if (!canFetchAuxiliaryData) {
    return false;
  }
  // FEA-4177 parity: once we hold last-good summary usage, a BACKGROUND refetch
  // (a paging/sort/search change re-running the combined read, or `keepPrevious`
  // placeholder data) must NOT skeleton the cards — the summary aggregate is
  // scope-stable across pagination, so a five-card grey flash on every table
  // click reads as "the numbers are reloading" when they cannot change. Mirror
  // the web page's `isLoading` (initial-load-only) gate: skeleton solely on the
  // true first load, when there is neither data nor a settled error yet.
  if (hasData || isError) {
    return false;
  }
  return isFetching || isPlaceholderData;
}

/**
 * ISS-8909 — the read state the desktop Sessions surface is CONTROLLED by.
 *
 * `SessionsListSurfaceV2` takes `controlledView.readState` ahead of every signal
 * it could derive for itself (`resolveSessionsListSurfaceReadState` returns it
 * before it looks at `isError`), so a term the read model cannot see never
 * reaches the body at all.
 *
 * The wedged db-host transient is exactly that term. The read has errored but
 * still HOLDS a settled page, so `resolveSessionsListReadModel` walks past its
 * error branch — which requires `!hasCurrentData` — and answers `Settled`. The
 * surface then renders the genuine "no sessions yet" over a source that is
 * failing.
 *
 * The v1 body never had this problem: it read `deriveSessionsAvailability`'s
 * exhaustion-agnostic `isUnavailable` directly. Retiring v1 left that signal
 * derived and unconsumed, which is the defect — ISS-4483 (review cid 3679535437)
 * and ISS-7528 both require a wedged transient to fall through to the error card
 * that carries the recovery action, never to an empty state claiming the reader
 * has nothing.
 *
 * Unavailability is reported WITHOUT folding in whether the source is currently
 * reconnecting, exactly as `deriveSessionsAvailability` reports the two as
 * separate signals. They are one question each: `Unavailable` puts the body in
 * the unavailable family at all, and the surface's own `isSyncing` prop then
 * picks WHICH member of it renders — the quiet "Getting your sessions ready"
 * while a transient failure is still being re-read, the error card with the
 * recovery action once it has stopped retrying. Collapsing them here (returning
 * early while syncing) drops the body out of that family altogether and renders
 * the genuine "no sessions yet" over a source that is failing, which is the
 * ISS-7528 defect in a second costume.
 *
 * A pending read still wins: nothing has settled yet to be unavailable about.
 */
export function resolveDesktopSessionsListReadState({
  isUnavailable,
  readState,
}: {
  isUnavailable: boolean;
  readState: SessionsListReadState;
}): SessionsListReadState {
  if (!isUnavailable) {
    return readState;
  }
  if (isSessionsListReadPending(readState)) {
    return readState;
  }
  return SessionsListReadState.Unavailable;
}
