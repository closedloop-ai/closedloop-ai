"use client";

import {
  setPrimaryTableSort,
  type TableSortRule,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { DEFAULT_DATE_RANGE } from "../../../shared/lib/format-utils";
import { CLEARED_SESSION_FACETS } from "./sessions-list-facets";
import { useSessionsSavedViewApplyHandler } from "./sessions-list-saved-views";
import {
  resolveSummaryCardToggle,
  toSessionsSortRules,
} from "./sessions-list-surface-controls";
import { toggleSetMember } from "./sessions-list-surface-model";
import { toSessionsListSortField } from "./sessions-list-surface-rows";
import type { SessionsListSurfaceV2Props } from "./sessions-list-surface-v2-props";
import {
  EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
  type SessionsListViewPatch,
  type SessionsListViewState,
  sessionsListSortPatch,
} from "./sessions-list-view-state";

/**
 * Every way `SessionsListSurfaceV2` MUTATES its own view that is not about one
 * FACET — "clear everything", the sort writers, the column and summary-card
 * toggles, the page size and the saved-view writers.
 *
 * Extracted from the surface (ISS-9555) as one responsibility rather than a
 * line-count slice: each of these is a closure over `view`/`updateView` whose
 * whole job is to move one or more view axes in ONE commit, and the reasons
 * they must be single commits are the same reason repeated. Keeping them
 * together is what lets a reader check that property once. Every body below is
 * the surface's own, moved unchanged.
 *
 * The per-facet mutations are NOT here. They were, and the surface's only use
 * of them was to relay them straight into `useSessionsListFilterModel` — four
 * pass-through parameters, and a split along a technical axis (mutations vs
 * view-model) rather than the domain one. They live with the facets they move,
 * in the hook that already owns `facets` and builds every view model over them.
 * `clearAllFilters` stays because the surface itself calls it, from the empty
 * state and the toolbar.
 */
export function useSessionsListViewActions({
  grouping,
  hiddenSummaryCards,
  onCustomDateWindowChange,
  onPageSizeChange,
  onToggleSummaryCard,
  savedViews,
  setUncontrolledPageSize,
  sorts,
  updateView,
  view,
}: {
  grouping: SessionsListViewState["grouping"];
  hiddenSummaryCards: SessionsListSurfaceV2Props["hiddenSummaryCards"];
  onCustomDateWindowChange: SessionsListSurfaceV2Props["onCustomDateWindowChange"];
  onPageSizeChange: SessionsListSurfaceV2Props["onPageSizeChange"];
  onToggleSummaryCard: SessionsListSurfaceV2Props["onToggleSummaryCard"];
  savedViews: SessionsListSurfaceV2Props["savedViews"];
  setUncontrolledPageSize: (pageSize: number) => void;
  sorts: readonly TableSortRule[];
  updateView: (patch: SessionsListViewPatch) => void;
  view: SessionsListViewState;
}) {
  /**
   * Clears every facet, the custom-field filters, the window AND the owner
   * scope, returning to page 1 in ONE commit.
   *
   * ISS-8037: the scope is in here rather than removed by a follow-up write.
   * "Clear filters" that left the list still narrowed by the scope would be a
   * control that does not work — a worse answer than the wrong message it was
   * meant to replace.
   */
  const clearAllFilters = () => {
    // Called FIRST so a host folds the `?from=`/`?to=` strip into the single URL
    // write the view change below triggers. A second write built from the same
    // pre-click search-params snapshot would restore what the first removed.
    onCustomDateWindowChange?.(null);
    updateView({
      customFieldFilters: EMPTY_SESSIONS_CUSTOM_FIELD_FILTERS,
      facets: CLEARED_SESSION_FACETS,
      dateRange: DEFAULT_DATE_RANGE,
      page: 0,
      scopeUserId: null,
      search: "",
    });
  };

  /**
   * Every ORDER change returns to page 1, exactly as both hosts do
   * (`SessionsView.handleSort` and the web page's `handleSort` each follow
   * `setSort` with a page reset). Re-ordering re-decides which rows fall in
   * which page, so holding the index means resuming a NEW order partway
   * through — skipping its start — and, server-driven, can name a page the
   * re-ordered result no longer has. One commit, like the facet and window
   * changes above, so the page reset cannot derive from a pre-update value and
   * discard the sort (review cid 3845403856).
   */
  const clearSort = () => updateView({ ...sessionsListSortPatch([]), page: 0 });
  const applySort = (fieldId: string, direction?: "asc" | "desc") => {
    const typedFieldId = toSessionsListSortField(fieldId);
    if (!typedFieldId) {
      return;
    }
    const currentDirection = sorts.find(
      (sort) => sort.fieldId === typedFieldId
    )?.direction;
    const next = toSessionsSortRules(
      setPrimaryTableSort(
        sorts,
        typedFieldId,
        direction ?? currentDirection ?? "asc"
      )
    );
    updateView({ ...sessionsListSortPatch(next), page: 0 });
  };
  const applySorts = (nextSorts: readonly TableSortRule[]) =>
    updateView({
      ...sessionsListSortPatch(toSessionsSortRules(nextSorts)),
      page: 0,
    });
  // Functional for the same reason the facet toggles are: the next set derives
  // from the current one, so a second toggle in one event must not rebuild from
  // the render-time set.
  const toggleColumn = (columnId: string) =>
    updateView((current) => ({
      visibleColumnIds: toggleSetMember(current.visibleColumnIds, columnId),
    }));
  const toggleSummaryCard = resolveSummaryCardToggle(
    updateView,
    hiddenSummaryCards,
    onToggleSummaryCard
  );
  const groupFromHeader = (columnId: string) =>
    updateView({
      grouping: {
        ...grouping,
        primary: { ...grouping.primary, fieldId: columnId },
      },
      page: 0,
    });
  const changePageSize = (nextPageSize: number) => {
    if (onPageSizeChange) {
      onPageSizeChange(nextPageSize);
    } else {
      setUncontrolledPageSize(nextPageSize);
    }
    updateView({ page: 0 });
  };
  const applySavedView = useSessionsSavedViewApplyHandler(
    savedViews,
    updateView
  );
  const saveCurrentView = (name: string) => savedViews?.onSave(name, view);

  return {
    applySavedView,
    applySort,
    applySorts,
    changePageSize,
    clearAllFilters,
    clearSort,
    groupFromHeader,
    saveCurrentView,
    toggleColumn,
    toggleSummaryCard,
  };
}
