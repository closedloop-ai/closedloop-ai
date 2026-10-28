"use client";

import type { ListSurfaceSortGrouping } from "@repo/app/shared/components/list-surface-toolbar-parts";
import { ListSurfaceToolbarV2 } from "@repo/app/shared/components/list-surface-toolbar-v2";
import type { ListToolbarSearchControl } from "@repo/app/shared/components/list-toolbar-search";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters";
import { TableResetViewMenuItem } from "@repo/design-system/components/ui/table-options-menu-v2";
import { TableSavedViewsMenu } from "@repo/design-system/components/ui/table-saved-views-menu-v2";
import type { TableToggleOption } from "@repo/design-system/components/ui/table-toolbar-model";
import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import type { ReactNode } from "react";
import { TimezoneModeFilter } from "../../../shared/components/timezone-mode-filter";
import {
  DEFAULT_TIMEZONE_MODE,
  type TimezoneMode,
} from "../../../shared/lib/date-window-timezone-mode";
import type { SessionCustomDateWindow } from "../../lib/session-custom-date-window";
import { SessionsCustomRangeControl } from "./sessions-custom-range-control";
import type { SessionsSavedViewsController } from "./sessions-list-saved-views";
import { sessionsSavedViewOptions } from "./sessions-list-saved-views";

export function SessionsListToolbarV2({
  activeFiltersViewModel,
  columns,
  customDateWindow,
  dateRange,
  dateRangeOptions,
  onCustomDateWindowChange,
  timezoneMode = DEFAULT_TIMEZONE_MODE,
  onTimezoneModeChange,
  filterController,
  filterViewModel,
  hiddenSummaryCardIds,
  exportItem,
  onAddField,
  onClearFilters,
  onDateRangeChange,
  onResetView,
  onToggleColumn,
  onToggleSummaryCard,
  savedViews,
  onApplySavedView,
  onSaveView,
  search,
  sortGrouping,
  summaryCards,
  toolbarPrimary,
  toolbarTrailing,
  visibleColumnIds,
}: {
  activeFiltersViewModel?: TableFiltersViewModel;
  columns: readonly TableToggleOption[];
  /** ISS-9107 @see SessionsListSurfaceV2Props.customDateWindow */
  customDateWindow?: SessionCustomDateWindow | null;
  dateRange: string;
  dateRangeOptions: readonly TableDateRangeOption[];
  /** ISS-9107 @see SessionsListSurfaceV2Props.onCustomDateWindowChange */
  onCustomDateWindowChange?: (window: SessionCustomDateWindow | null) => void;
  /** ISS-9619 @see SessionsListSurfaceV2Props.timezoneMode */
  timezoneMode?: TimezoneMode;
  /** ISS-9619 @see SessionsListSurfaceV2Props.onTimezoneModeChange */
  onTimezoneModeChange?: (mode: TimezoneMode) => void;
  filterController: TableFiltersController;
  filterViewModel: TableFiltersViewModel;
  hiddenSummaryCardIds: ReadonlySet<string>;
  exportItem?: ReactNode;
  /**
   * Accepted while callers migrate to the grid's trailing header control.
   * The Sessions toolbar does not render this action at either width.
   */
  onAddField?: () => void;
  onClearFilters?: () => void;
  onDateRangeChange: (value: string) => void;
  /**
   * ISS-7052 Part A: restore the table's shipped defaults. Omitted, neither menu
   * renders the row — a surface whose view is not persisted has nothing to reset
   * to, and an action that does nothing is worse than an absent one.
   */
  onResetView?: () => void;
  onToggleColumn: (columnId: string) => void;
  onToggleSummaryCard?: (cardId: string) => void;
  savedViews?: SessionsSavedViewsController;
  /** PRD-721 @see ListSurfaceToolbarV2.search */
  search?: ListToolbarSearchControl;
  /**
   * Reachable only through {@link savedViews} — `renderSavedViewsMenu` mounts
   * the menu that calls these two and nothing else does, so a host with no
   * saved-views controller (ISS-10361: the web v1 listing, which has none) omits
   * both rather than passing a callback that can never fire.
   */
  onApplySavedView?: (viewId: string) => void;
  onSaveView?: (name: string) => void;
  /**
   * ISS-10361 (tamsinb review): the ordering-and-grouping cluster as ONE
   * object, so a host cannot wire half of it. These used to be ten sibling
   * optional props reassembled by a runtime all-or-nothing check, which let a
   * caller drop one, still compile, and silently lose both menus.
   * {@link ListSurfaceSortGrouping} carries the same contract for every surface.
   */
  sortGrouping?: ListSurfaceSortGrouping;
  /**
   * FEA-4217: the summary-card rows to offer, or `undefined` to offer none. A
   * row that moves and reports nowhere is a lying control, so the SURFACE
   * decides whether the pair behind these rows is honest; this toolbar only
   * renders what it is handed.
   */
  summaryCards?: readonly TableToggleOption[];
  /**
   * ISS-5316: the host's own toolbar slots, forwarded to `GridTableToolbar`. The
   * surface has no opinion about what they hold, so it must not swallow them —
   * `primary` sits beside this toolbar's saved-view control rather than
   * replacing it, and `trailing` is the page's primary action.
   */
  toolbarPrimary?: ReactNode;
  /** @see toolbarPrimary */
  toolbarTrailing?: ReactNode;
  visibleColumnIds: ReadonlySet<string>;
}) {
  const visibleSummaryCardIds = new Set(
    (summaryCards ?? [])
      .map((card) => card.key)
      .filter((cardId) => !hiddenSummaryCardIds.has(cardId))
  );
  // Composed ONCE and handed to both the wide options menu and the folded one.
  // Two literals would let the pair drift, which on this slot means an action
  // that silently disappears when the window crosses the fold.
  const viewMenuTrailing = (
    <>
      {exportItem}
      {onResetView ? <TableResetViewMenuItem onSelect={onResetView} /> : null}
    </>
  );
  return (
    <ListSurfaceToolbarV2
      activeFiltersViewModel={activeFiltersViewModel}
      columns={columns}
      // ISS-9107: an explicit window supersedes the preset, so no preset may
      // read as selected while one is active — an empty value deselects the
      // whole group. The named Custom control beside it is what the reader then
      // sees and clears.
      dateRange={customDateWindow == null ? dateRange : ""}
      dateRangeOptions={dateRangeOptions}
      filterController={filterController}
      filterViewModel={filterViewModel}
      leadingTrailing={
        <>
          {/* ISS-9619: absent while an explicit from/to window is in charge —
              those bounds are literal UTC calendar days, so the control would
              move nothing a reader could see. */}
          {onTimezoneModeChange === undefined ||
          (customDateWindow ?? null) !== null ? null : (
            <TimezoneModeFilter
              onChange={onTimezoneModeChange}
              value={timezoneMode}
            />
          )}
          {onCustomDateWindowChange === undefined ? null : (
            <SessionsCustomRangeControl
              onChange={onCustomDateWindowChange}
              value={customDateWindow ?? null}
            />
          )}
        </>
      }
      metrics={summaryCards}
      onAddField={onAddField}
      onClearFilters={onClearFilters}
      onDateRangeChange={onDateRangeChange}
      onToggleColumn={onToggleColumn}
      onToggleMetric={onToggleSummaryCard}
      optionsTrailing={viewMenuTrailing}
      primary={toolbarPrimary}
      savedViews={renderSavedViewsMenu({
        onApplySavedView,
        onSaveView,
        savedViews,
      })}
      search={search}
      sortGrouping={sortGrouping}
      trailing={toolbarTrailing}
      visibleColumnIds={visibleColumnIds}
      visibleMetricKeys={visibleSummaryCardIds}
    />
  );
}

/** The saved-views menu, or nothing when the host supplies no saved views. */
function renderSavedViewsMenu({
  onApplySavedView,
  onSaveView,
  savedViews,
}: {
  onApplySavedView?: (viewId: string) => void;
  onSaveView?: (name: string) => void;
  savedViews?: SessionsSavedViewsController;
}): ReactNode {
  if (!(savedViews && onApplySavedView && onSaveView)) {
    return null;
  }
  return (
    <TableSavedViewsMenu
      activeViewId={savedViews.activeViewId}
      onApply={onApplySavedView}
      onSave={onSaveView}
      views={sessionsSavedViewOptions(savedViews)}
    />
  );
}
