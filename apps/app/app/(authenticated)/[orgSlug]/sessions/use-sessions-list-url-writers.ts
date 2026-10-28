"use client";

import {
  type SessionsListParamsReplacer,
  useSessionsListUrlWriters as useSharedSessionsListUrlWriters,
} from "@repo/app/agents/hooks/use-sessions-list-url-writers";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
} from "@repo/app/agents/lib/session-filter-adapter";
import { SESSIONS_SEARCH_PARAM } from "@repo/app/agents/lib/session-url-scope-params";
import {
  type DateRange,
  DEFAULT_DATE_RANGE,
} from "@repo/app/shared/lib/format-utils";
import { useCallback } from "react";
import { restoreGatedProjectFacet } from "./sessions-page-scope";

/**
 * The org Sessions page's own list-URL writers: the shared ones, plus the three
 * things that are this host's and stay this host's.
 *
 * ISS-9555 slice 4 moved the facet, window and page writes into
 * `@repo/app/agents/hooks/use-sessions-list-url-writers`, which the desktop
 * shell mounts too — that module carries the ISS-4728 one-write-per-handler
 * contract, and it was that contract being fixed on one host at a time that the
 * collapse ends. What could not move is the Project-facet gate, the `?userId=`
 * scope key, the page-reset marker, and the V1 chip row's own removal handler:
 * the desktop shell has none of them.
 */
export function useSessionsListUrlWriters({
  facetFilters,
  markPageReset,
  projectFacetEnabled,
  replaceListParams,
  selectedUserParam,
  setDateRange,
  setFacetFilters,
}: {
  /** The page's facet state, as the window writers must re-assert it. */
  facetFilters: SessionFacetFilters;
  markPageReset: () => void;
  /**
   * Whether the Project facet is gated ON. Only `handleScopeChange` reads it,
   * and only to tell a facet object the GATE emptied from one the reader did —
   * see {@link restoreGatedProjectFacet}.
   */
  projectFacetEnabled: boolean;
  replaceListParams: SessionsListParamsReplacer;
  /**
   * The page-owned `?userId=` scope param. Passed in rather than re-declared
   * here: `page.tsx` owns the name (an App Router page module cannot export it),
   * and two spellings of the same key is a strip that silently misses.
   */
  selectedUserParam: string;
  setDateRange: (next: DateRange) => void;
  setFacetFilters: (next: SessionFacetFilters) => void;
}) {
  const {
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleScopeChange: writeScopeChange,
  } = useSharedSessionsListUrlWriters({
    facetFilters,
    markPageReset,
    replaceListParams,
    setDateRange,
    setFacetFilters,
  });

  /**
   * The window, the facets AND the owner scope, moved in ONE history write.
   *
   * ISS-7052 Part A (whitlockk review): the v2 toolbar's "Clear all" changes all of
   * them in a single surface update, and routing that through
   * `handleDateRangeChange` followed by `handleFiltersChange` is the trap the
   * shared module documents. Which is also why no strip is unconditional: a
   * facet-only change must LEAVE an inbound window alone, and a change that did
   * not touch the scope must leave `?userId=` alone, so each set rides the write
   * only when its own axis actually moved. `resolveSessionsScopeDelta` decides
   * the preset and the scope; the EXPLICIT window is the caller's to report,
   * because a surface reports its clear through a separate callback and only the
   * caller's fold knows one is pending (ISS-9822).
   */
  const handleScopeChange = useCallback(
    ({
      clearScopeUser,
      clearWindow = false,
      dateRange: nextDateRange,
      facets,
      search,
    }: {
      clearScopeUser: boolean;
      /**
       * Strip `?from=`/`?to=` even though the PRESET did not move. Defaulted off
       * so the V1 chip row and every other caller keeps leaving an inbound
       * window where the reader found it.
       */
      clearWindow?: boolean;
      dateRange: DateRange | null;
      facets: SessionFacetFilters;
      /** PRD-721: the new `?search=` term (`""` clears it), or `null`. */
      search?: string | null;
    }) => {
      // ISS-8037 (codex review): the delta's facets are the GATED object the v2
      // surface was handed, so with the Project facet flag off their
      // `projectIds` are empty because the gate emptied them — not because the
      // reader did. Restored before the write, because it is lost otherwise:
      // `writeSessionFacetFilterParams` would delete an inbound `?project=` the
      // gate had only made inert, and `setFacetFilters` would drop it from the
      // state the next write re-asserts from.
      writeScopeChange({
        clearParamKeys: clearScopeUser ? [selectedUserParam] : [],
        clearWindow,
        dateRange: nextDateRange,
        facets: restoreGatedProjectFacet(
          facets,
          facetFilters,
          projectFacetEnabled
        ),
        search:
          search === null || search === undefined
            ? null
            : { param: SESSIONS_SEARCH_PARAM, value: search },
      });
    },
    [facetFilters, projectFacetEnabled, selectedUserParam, writeScopeChange]
  );

  const handleClearFilters = useCallback(() => {
    // Reset the facets + page in the URL and strip the URL-owned `userId`
    // narrower the facet writer doesn't manage (FEA-4181), so the clear can't
    // re-run the same narrowed empty result.
    // ISS-5355 adds `?range=` to that set: it is URL-owned too, and leaving it
    // would keep the inbound window narrowing a view the user just cleared.
    writeScopeChange({
      clearParamKeys: [selectedUserParam, SESSIONS_SEARCH_PARAM],
      clearWindow: true,
      dateRange: DEFAULT_DATE_RANGE,
      facets: DEFAULT_SESSION_FACET_FILTERS,
    });
  }, [selectedUserParam, writeScopeChange]);

  /**
   * ISS-4728 — remove the selected-user scope from the V1 chip row, leaving the
   * date window and every facet that row did not fold in where they are. The v2
   * surface reaches the same removal through `handleScopeChange` instead, since
   * it reports the scope as a view-state axis rather than as its own callback.
   *
   * `nextFilters` comes from the chip row and is the ONLY facet state this write
   * may use: when the scoped user is also a selected Owner facet value the two
   * chips collapse into one, so removing it has to drop BOTH narrowers — and it
   * has to do so in ONE write (review cid 3701353686).
   *
   * Page resets to 0 because the row set widens under it and page N of the
   * narrowed list is not page N of the wider one.
   */
  const handleRemoveSelectedUser = useCallback(
    (nextFilters: SessionFacetFilters) => {
      writeScopeChange({
        clearParamKeys: [selectedUserParam],
        clearWindow: false,
        dateRange: null,
        facets: nextFilters,
      });
    },
    [selectedUserParam, writeScopeChange]
  );

  return {
    handleClearFilters,
    handleCustomDateWindowChange,
    handleDateRangeChange,
    handleFiltersChange,
    handleRemoveSelectedUser,
    handleScopeChange,
  };
}
