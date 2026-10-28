"use client";

import { ActiveFiltersBar as ForkActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar-v2";
import { FilterPopover as ForkFilterPopover } from "@repo/design-system/components/ui/filter-popover-v2";
import { useFeatureFlagEnabledOptional } from "../feature-flags/use-feature-flag-enabled";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import type { ListSurfaceToolbarProps } from "./list-surface-toolbar";
import { ListSurfaceToolbar } from "./list-surface-toolbar";
import { ListSurfaceToolbarLayout } from "./list-surface-toolbar-layout";

export type { ListSurfaceSortGrouping } from "./list-surface-toolbar-parts";

/**
 * ISS-9225 — the ONE toolbar every Grid Table v2 list surface renders.
 *
 * `GridTableToolbar` owns the layout spine and deliberately takes slots, which
 * left each surface free to decide independently WHICH catalog controls fill
 * them. Sessions built a real one; Branches shipped no v2 toolbar at all and let
 * every host inject an opaque `ReactNode`. This is the missing agreement one
 * level above the spine: the same date-range toggle, the same filter popover,
 * the same sort/group/options menus, in the same order, folding the same way.
 *
 * A control a surface genuinely does not have is an OMITTED argument, not a
 * fork: omit `sortGrouping` and the sort and group menus are absent, and the
 * narrow fold collapses to the Options menu it still has. A control with no
 * analogue on the other surface COMPOSES in through `leadingTrailing`,
 * `primary`, `trailing` or `optionsTrailing` rather than growing a second
 * toolbar beside this one.
 *
 * ISS-13035: this is the one `gridview-adoption` read for Sessions and Branches.
 * Open, it is the shared `ListSurfaceToolbar` (search, "Filters", Sort in the
 * toolbar, saved views and Add field on the right). Closed, it is the toolbar
 * those pages had before the shared one, whatever the page also supplied.
 */
export function ListSurfaceToolbarV2<
  TStatus extends string = string,
  TPriority extends string = string,
>(
  props: ListSurfaceToolbarProps<TStatus, TPriority> & {
    /** Keep Sort in the folded card menu only when wide headers own sorting. */
    sortPlacement?: "all" | "compact";
  }
) {
  const championControls = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  if (championControls) {
    return <ListSurfaceToolbar {...props} />;
  }
  const {
    activeFiltersViewModel,
    filterController,
    filterViewModel,
    onClearFilters,
    primary,
    savedViews,
  } = props;
  return (
    <ListSurfaceToolbarLayout
      activeFilters={
        activeFiltersViewModel ? (
          <div className="-mx-4">
            <ForkActiveFiltersBar
              controller={filterController}
              viewModel={activeFiltersViewModel}
            />
          </div>
        ) : null
      }
      columns={props.columns}
      dateRange={props.dateRange}
      dateRangeOptions={props.dateRangeOptions}
      filterPopover={
        <ForkFilterPopover
          controller={filterController}
          onClear={onClearFilters}
          viewModel={filterViewModel}
        />
      }
      leadingTrailing={props.leadingTrailing}
      metrics={props.metrics}
      mode={props.mode}
      onDateRangeChange={props.onDateRangeChange}
      onToggleColumn={props.onToggleColumn}
      onToggleMetric={props.onToggleMetric}
      optionsTrailing={props.optionsTrailing}
      primary={
        savedViews || primary ? (
          <div className="flex items-center gap-2">
            {savedViews}
            {primary}
          </div>
        ) : null
      }
      sortGrouping={props.sortGrouping}
      sortPlacement={props.sortPlacement}
      trailing={props.trailing}
      visibleColumnIds={props.visibleColumnIds}
      visibleMetricKeys={props.visibleMetricKeys}
    />
  );
}
