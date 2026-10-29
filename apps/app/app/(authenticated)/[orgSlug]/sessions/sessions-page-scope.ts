import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  hasAnyActiveSessionFacet,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";

/**
 * The org Sessions page's pure scope derivations, extracted from `page.tsx` when
 * FEA-4201's explicit-window wiring pushed that file over the 1,000-line
 * ceiling. Nothing here touches React or the router: each answers a question
 * about the CURRENT scope from values the page already holds.
 *
 * ISS-8909 moved the v2 surface's view-change ROUTING out of here to
 * `@repo/app/agents/lib/sessions-host-view-change`: the desktop renderer became
 * a second host of that surface, and the order those writes have to land in
 * belongs to the surface's controller contract rather than to this page.
 */

export function resolveSessionsScopeState({
  customDateWindow,
  dateRange,
  effectivePageIndex,
  facetFilters,
  search = "",
  selectedUserId,
}: {
  customDateWindow: SessionCustomDateWindow | null;
  dateRange: DateRange;
  effectivePageIndex: number;
  facetFilters: SessionFacetFilters;
  /** PRD-721: the resolved toolbar search term. */
  search?: string;
  selectedUserId: string | null;
}): {
  hasActiveFilters: boolean;
  isListScopeDefault: boolean;
  isUsageScopeDefault: boolean;
} {
  // FEA-4201: an explicit window narrows the list whatever the preset says, so
  // Clear must be offered and the scope must not read as default — otherwise the
  // recovery control would "clear" to the same narrowed rows.
  const hasActiveFilters =
    customDateWindow !== null ||
    dateRange !== DEFAULT_DATE_RANGE ||
    hasAnyActiveSessionFacet(facetFilters) ||
    Boolean(selectedUserId) ||
    search !== "";
  return {
    hasActiveFilters,
    isListScopeDefault: !hasActiveFilters && effectivePageIndex === 0,
    isUsageScopeDefault: !hasActiveFilters,
  };
}

/**
 * FEA-4201 — whether the Sessions reads may fire yet.
 *
 * Three independent gates, ANDed, because any one resolving late changes what
 * the reads ask for. `isViewReady` is ISS-6382's saved-view restore;
 * `isCustomDateWindowReady` is the explicit window's flag gate, which matters
 * because an asynchronous provider reports an unresolved flag as `false` and
 * `false` is indistinguishable from "off" — so a flagged `?from=`/`?to=` link
 * would read the PRESET window first and refetch the requested one.
 *
 * ISS-9692 (whitlockk review) adds `isPageSizeReady`, the same hazard applied to the
 * `limit`: `table-page-size-ladder` decides which rungs are legal, so until it
 * answers a viewer holding a stored 500 resolves to 100 — the largest rung of
 * the CLOSED ladder — and would read one 100-row page before refetching at 500.
 * A third gate for the same reason the second is one: it waits on its own flag,
 * and it is the only one of the three that can still change the page SIZE.
 *
 * ISS-8190's fourth gate, `isSavedAutonomySortReady`, is gone with ISS-10301:
 * it waited on `grid-table-v2` because the v1 controls could not name an
 * Autonomy sort, and with v1 retired there is no second sort vocabulary.
 *
 * Named here rather than inlined at the call site so the page keeps one
 * readiness answer feeding every read, and so the gates cannot drift apart
 * across the list, the summary, the snapshot and the export.
 */
export function resolveSessionsReadReady(
  isViewReady: boolean,
  isCustomDateWindowReady: boolean,
  isPageSizeReady: boolean
): boolean {
  return isViewReady && isCustomDateWindowReady && isPageSizeReady;
}

export function applyProjectFacetGate(
  filters: SessionFacetFilters,
  projectFacetEnabled: boolean
): SessionFacetFilters {
  if (projectFacetEnabled) {
    return filters;
  }
  return {
    ...filters,
    projectIds: DEFAULT_SESSION_FACET_FILTERS.projectIds,
  };
}

/**
 * ISS-8037 (codex review) — the raw `?userId=` param as a SCOPE, or `null`.
 *
 * `URLSearchParams.get` answers `""`, not `null`, for a URL ending in
 * `?userId=`, and the page then asked two questions of that one value with two
 * different tests: {@link resolveSessionsScopeState} reads it through
 * `Boolean(selectedUserId)` and calls the list unscoped, while the v2 view-state
 * axis is compared with `!== null` and calls it scoped. One URL, two components
 * disagreeing — an empty Owner chip and a "Clear all" offering to remove a
 * narrower the reads never applied, over a list nothing had narrowed.
 *
 * Normalised at the single READ rather than by teaching each consumer the same
 * emptiness check, so the two answers agree by construction: an empty param is
 * not a scope on the empty string, it is the absence of a scope, and no
 * downstream reader ever sees the other spelling.
 */
export function readSessionsScopeUserId(
  rawParam: string | null
): string | null {
  if (rawParam === null || rawParam === "") {
    return null;
  }
  return rawParam;
}

/**
 * ISS-8037 (codex review) — put back what the GATE suppressed, never what the
 * reader cleared.
 *
 * {@link applyProjectFacetGate} empties `projectIds` when the Project facet flag
 * is off, and `effectiveFacetFilters` — the gated object — is what the v2
 * surface is handed and therefore what it reports back. Writing that straight to
 * the list URL makes `writeSessionFacetFilterParams` DELETE an inbound
 * `?project=` that the gate had merely rendered inert, so removing the Owner
 * chip silently dropped a project narrower the reader never touched (and
 * `setFacetFilters` dropped it from page state along with it).
 *
 * The surface cannot move an axis it was never shown, so with the flag off the
 * page's own un-gated `facetFilters` is the only truth for `projectIds`. With
 * the flag ON the gate is the identity function and so is this, which is what
 * keeps a GENUINE project clear removing the param.
 *
 * The stated consequence: the v2 "Clear all" leaves a flag-off `?project=`
 * standing, where the v1 `handleClearFilters` deletes it. That param narrows
 * NOTHING while the flag is off (`resolveSessionsScopeState` and both reads are
 * keyed on the gated facets), so what is left behind is an inert deep-link value
 * — which is the cheaper of the two errors against destroying a narrower the
 * reader can neither see nor restore.
 */
export function restoreGatedProjectFacet(
  next: SessionFacetFilters,
  owned: SessionFacetFilters,
  projectFacetEnabled: boolean
): SessionFacetFilters {
  if (projectFacetEnabled || next.projectIds === owned.projectIds) {
    return next;
  }
  return { ...next, projectIds: owned.projectIds };
}
