"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type {
  FilterMenuGroup,
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";
import { useMemo } from "react";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../../shared/lib/facet-filter";
import {
  foldOwnerScopeIntoFacetGroups,
  foldSessionSearchIntoFacetGroups,
} from "../../lib/session-active-filter-chips";
import {
  type SessionFacetFilters,
  useSessionFilterFacetGroups,
  withoutOwnerFacetValue,
} from "../../lib/session-filter-adapter";
import {
  type buildSessionsCustomFieldColumns,
  hasActiveSessionsCustomFieldFilters,
  representableCustomFieldFilters,
} from "./sessions-list-custom-fields";
import { applyFacetToggle, reconcileFacetChange } from "./sessions-list-facets";
import { renderSessionsHeaderFilterContent } from "./sessions-list-surface-filter-content";
import {
  isSessionsListNarrowedOnlyByWindow,
  resolveSessionsCustomFieldFacetGroups,
  resolveSessionsCustomFieldFilterHandlers,
  resolveSessionsFiltersActive,
  resolveSessionsNonWindowFiltersActive,
} from "./sessions-list-surface-model";
import { collectOwners, collectStatuses } from "./sessions-list-surface-rows";
import type { SessionsListSurfaceV2Props } from "./sessions-list-surface-v2-props";
import type {
  SessionsListViewPatch,
  SessionsListViewState,
} from "./sessions-list-view-state";

/**
 * The filter half of `SessionsListSurfaceV2`: what this mount OFFERS to filter
 * by, what is currently SELECTED, and whether anything is narrowing the list.
 *
 * Extracted from the surface (ISS-9555) as one responsibility. The three view
 * models it returns are deliberately not one — the popover's, the chip row's
 * and the per-column header's each answer a different question about the same
 * facets — and the comments below are the record of why they may not be
 * collapsed. Every body is the surface's own, moved unchanged.
 *
 * The per-facet MUTATIONS are here too, not in `useSessionsListViewActions`:
 * they moved the axes this hook already owns, and the surface's only use of
 * them was to relay them here (ISS-9555 review). `clearAllFilters` is the one
 * that genuinely arrives from outside, because the surface calls it itself.
 */
export function useSessionsListFilterModel({
  clearAllFilters,
  customDateWindow,
  customFieldColumns,
  customFieldFilters,
  customFields,
  dateRange,
  facets,
  hasSessionsOutsideWindow,
  includeProjectFilter,
  isServerDriven,
  resolveOwnerName,
  resolveProjectName,
  rows,
  scopeUserId,
  searchTerm,
  sorted,
  updateView,
  usage,
}: {
  clearAllFilters: () => void;
  customDateWindow: SessionsListSurfaceV2Props["customDateWindow"];
  customFieldColumns: ReturnType<typeof buildSessionsCustomFieldColumns>;
  customFieldFilters: NonNullable<SessionsListViewState["customFieldFilters"]>;
  customFields: SessionsListSurfaceV2Props["customFields"];
  dateRange: SessionsListViewState["dateRange"];
  facets: SessionsListViewState["facets"];
  hasSessionsOutsideWindow: SessionsListSurfaceV2Props["hasSessionsOutsideWindow"];
  includeProjectFilter: boolean;
  isServerDriven: boolean;
  resolveOwnerName: SessionsListSurfaceV2Props["resolveOwnerName"];
  resolveProjectName: SessionsListSurfaceV2Props["resolveProjectName"];
  rows: readonly SessionTableRow[];
  scopeUserId: SessionsListViewState["scopeUserId"];
  searchTerm: string;
  sorted: readonly SessionTableRow[];
  updateView: (patch: SessionsListViewPatch) => void;
  usage: SessionsListSurfaceV2Props["usage"];
}) {
  const statusOptions = useMemo(() => collectStatuses(rows), [rows]);
  const ownerOptions = useMemo(() => collectOwners(rows), [rows]);
  // One click can reach these several times with no render between, so they take
  // the functional patch form AND the rendered selection. See
  // {@link applyFacetToggle} for why both arrays are arguments.
  const toggleFacetValueFor = (key: "statuses" | "userIds", value: string) =>
    updateView((current) => ({
      facets: {
        ...current.facets,
        [key]: applyFacetToggle(current.facets[key], facets[key], value),
      },
      page: 0,
    }));
  const toggleStatusFilter = (value: string) =>
    toggleFacetValueFor("statuses", value);
  /**
   * ISS-8966: drop the search term.
   *
   * ONE patch, so it composes with the "Clear all" that may precede it in the
   * same click rather than settling on a second, different state — the search
   * group's `onToggle` is called synchronously right after `clearAllFilters`.
   * Page 0 because the row set WIDENS underneath: page N of the searched list is
   * not page N of the wider one.
   *
   * The host hears it as one settled `SessionsListViewState` and performs its own
   * URL strip inside the single write that carries the cleared facets, exactly as
   * it does for `scopeUserId`.
   */
  const clearSearch = () => updateView({ page: 0, search: "" });
  /**
   * Drop the owner scope, and with it the Owner FACET value when the same user
   * is selected there too — the merged case the single chip claims to cover.
   * One patch, so it composes with the "Clear all" that may precede it in the
   * same click instead of settling on a second, different state.
   *
   * Page 0 because the row set WIDENS underneath: page N of the scoped list is
   * not page N of the wider one. Both Sessions hosts reset the page on this
   * same removal.
   */
  const removeOwnerScope = (userId: string) =>
    updateView((current) => ({
      // The CANONICAL helper the v1 chip row already removes a scoped owner
      // with, not a second copy of the same expression — the two rows must not
      // be able to disagree about what a TOTAL removal drops.
      facets: withoutOwnerFacetValue(current.facets, userId),
      page: 0,
      scopeUserId: null,
    }));
  // Each of these moves TWO axes — the filter and the page — in ONE commit.
  // Written as two sequential writes they would both derive from the same
  // pre-update `value` in controlled mode, so the page reset would discard the
  // filter change.
  // `facetGroups` REPLACES the built-in assignee/status/priority categories, so
  // every other member of this controller is unreachable — the shared no-op is
  // what `SessionsToolbar` and `BranchesToolbar` pass for the same reason.
  // `clearAllFilters` is the one that runs, and it moves both axes in ONE commit.
  const filterController: TableFiltersController = {
    ...NOOP_TABLE_FILTERS_CONTROLLER,
    clearAllFilters,
  };
  // The CANONICAL builder both hosts already drive, so this surface offers the
  // same nine facets, labelled and ordered the same way, off the same usage
  // breakdowns — rather than a second, smaller vocabulary of its own.
  const serverFacetGroups = useSessionFilterFacetGroups(
    facets,
    (next: SessionFacetFilters) =>
      updateView((current) => ({
        facets: reconcileFacetChange(facets, next)(current.facets),
        page: 0,
      })),
    usage,
    {
      includeChangePrFilters: true,
      includeProjectFilter,
      resolveOwnerName,
      resolveProjectName,
      ...(isServerDriven ? {} : { statusOptions }),
    }
  );
  const presentedStatusOptions =
    serverFacetGroups.find((group) => group.id === "status")?.options ??
    statusOptions;
  // ISS-8216 moved this axis onto the view state, so both writers ride
  // `updateView` and live beside the facet builder that takes them.
  const {
    onRangeChange: changeCustomFieldRange,
    onToggle: toggleCustomFieldFilter,
  } = resolveSessionsCustomFieldFilterHandlers(updateView, customFieldFilters);
  const clientFacetGroups = [
    {
      id: "status",
      label: "Status",
      options: presentedStatusOptions,
      selectedValues: [...facets.statuses],
      onToggle: toggleStatusFilter,
    },
    {
      id: "owner",
      label: "Owner",
      options: ownerOptions,
      selectedValues: [...facets.userIds],
      onToggle: (value: string) => toggleFacetValueFor("userIds", value),
    },
    ...resolveSessionsCustomFieldFacetGroups(
      customFields,
      customFieldFilters,
      toggleCustomFieldFilter,
      changeCustomFieldRange
    ),
  ];
  // ISS-8037: the `?userId=` scope, folded into the Owner group it shares a
  // vocabulary with, so a menu or a chip row names it ONCE — and names it as the
  // same kind of thing a facet is, because to the reader it is: something
  // narrowing this list that they can take off.
  //
  // Applied to EVERY facet view model this surface builds, not just the chip
  // row's. `FilterPopover` counts `facetGroups.filter(isFilterMenuGroupActive)`,
  // so an unfolded popover renders a bare "Filter" with no count and no clear-X
  // beside a chip reading "Owner: …" — this ticket's own defect, one control
  // over. And `ActiveFiltersBar` builds its "+ Add filter" menu from the same
  // view model it chips from, so folding one and not the other left two facet
  // menus disagreeing about whether Owner was filtered.
  const withOwnerScope = (groups: FilterMenuGroup[]) =>
    scopeUserId === null
      ? groups
      : foldOwnerScopeIntoFacetGroups(
          groups,
          scopeUserId,
          () => removeOwnerScope(scopeUserId),
          resolveOwnerName
        );
  // ISS-8966: both out-of-facet narrowers, folded in one place so no call site
  // can carry one and forget the other.
  const withScopeChips = (groups: FilterMenuGroup[]) =>
    foldSessionSearchIntoFacetGroups(
      withOwnerScope(groups),
      searchTerm,
      clearSearch
    );
  const filterViewModel: TableFiltersViewModel = {
    teamMembers: [],
    statusOptions: [],
    priorityOptions: [],
    hideQuickToggles: true,
    facetGroups: withScopeChips(
      isServerDriven ? serverFacetGroups : clientFacetGroups
    ),
  };
  const getHeaderFilterContent = (columnId: string) =>
    renderSessionsHeaderFilterContent(filterViewModel, columnId);
  // The CHIP ROW is built from the SELECTED filters and deliberately does not
  // share the popover's view model (review cid 3845403849): what a surface may
  // OFFER says nothing about what is already SELECTED. A saved view or a shared
  // URL can hand back `changePresence`/`prAssociation`, and the host sends those
  // values in its query either way — so gating the chips would leave a filter
  // silently narrowing the list with no chip to name it and no remove path to
  // undo it. `SessionsActiveFiltersBar` passes `includeChangePrFilters: true`
  // for exactly this reason.
  const activeFiltersViewModel: TableFiltersViewModel = isServerDriven
    ? {
        ...filterViewModel,
        facetGroups: withScopeChips(serverFacetGroups),
      }
    : filterViewModel;
  // Only what THIS mount actually narrows by. Client-side that is the two
  // facets it filters on plus the window: counting the other seven would offer
  // "clear filters" for a selection no row was ever measured against. The
  // window counts in BOTH modes because ISS-8217 made it narrow in both —
  // `list-empty-state` is explicit that a non-default range is a narrowed
  // scope, and without it a windowed-away result reads "No sessions yet" at an
  // org that has plenty.
  //
  // ISS-8037: the owner scope counts too, threaded into the same helper that
  // owns the rest of the answer rather than OR-ed on at this one call site —
  // the row filter and the "is anything narrowing this list" count must not be
  // able to disagree about what an active scope means.
  const customFieldFiltersActive = hasActiveSessionsCustomFieldFilters(
    // The REPRESENTABLE subset, the same one the row filter narrows by: a
    // selection whose custom field is gone narrows nothing and has no chip, so
    // counting it here would offer "Clear filters" for a filter the reader can
    // neither see nor have felt.
    representableCustomFieldFilters(customFieldFilters, customFieldColumns)
  );
  const nonWindowFilters = {
    facets,
    isServerDriven,
    scopeUserId,
    search: searchTerm,
  };
  const filtersActive =
    resolveSessionsFiltersActive({
      customWindowActive: customDateWindow != null,
      dateRange,
      ...nonWindowFilters,
    }) || customFieldFiltersActive;
  const clientRowsNarrowedAway = rows.length > 0 && sorted.length === 0;
  /**
   * ISS-11913: the window alone is hiding sessions that exist. Server-driven
   * only the host's unwindowed probe can say so; client-side the population in
   * hand does.
   */
  const showAllTimeOffered =
    isSessionsListNarrowedOnlyByWindow({
      customWindowActive: customDateWindow != null,
      dateRange,
      otherFiltersActive:
        customFieldFiltersActive ||
        resolveSessionsNonWindowFiltersActive(nonWindowFilters),
    }) &&
    (isServerDriven
      ? hasSessionsOutsideWindow === true
      : clientRowsNarrowedAway);

  /**
   * ISS-8217: is anything narrowing this list, INCLUDING the default window the
   * reader never chose. `filtersActive` cannot answer that, and must not be
   * widened to: it also gates whether "Clear filters" is offered, and clearing
   * returns the window to its DEFAULT rather than removing it — so on a list
   * emptied by the default window that action would be a button that changes
   * nothing.
   *
   * Only the client arm can measure this directly: `rows` there is the whole
   * population, so a non-empty population resolving to no rows is exactly
   * "narrowed to nothing". Server-driven, `rows` is one already-filtered page
   * and the comparison would always read false, so the host's ISS-11913 probe
   * is the only evidence the default window is hiding anything.
   */
  const listNarrowed =
    filtersActive ||
    showAllTimeOffered ||
    (!isServerDriven && clientRowsNarrowedAway);

  return {
    activeFiltersViewModel,
    filterController,
    filterViewModel,
    filtersActive,
    getHeaderFilterContent,
    listNarrowed,
    showAllTimeOffered,
  };
}
