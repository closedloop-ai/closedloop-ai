"use client";

import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import { Input } from "@repo/design-system/components/ui/input";
import { SearchIcon } from "lucide-react";
import { DateRangeFilter } from "../../../shared/components/date-range-filter";
import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "../../../shared/lib/facet-filter";
import { AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import type { AgentsListSurfaceV2ViewModel } from "../../hooks/use-agents-list-surface-v2-view-model";
import {
  AGENTS_TIME_RANGE_LABELS,
  AGENTS_TIME_RANGE_SHORT_LABELS,
  AGENTS_TIME_RANGES,
  type AgentsTimeRange,
} from "../../lib/agents-timeframe";
import { AGENTS_TYPE_TAB_OPTIONS } from "../../lib/agents-type-tab-vocabulary";
import { agentComponentFilterFacetGroups } from "./agent-component-filter-adapter";
import { AgentsTypeTabStrip } from "./agents-type-tab-strip";
import { AgentsViewMenu } from "./agents-view-menu";

/**
 * `AgentsListSurfaceV2`'s controls: the type-tab strip on its own row, then
 * search / time window / facet filters / view menu (ISS-9398).
 *
 * Every control is the surface's, not a host's. `AgentsGroupedList` already
 * composed these itself; what changes is that there is no longer a slot beside
 * them a host could add to, so the two shells cannot grow different toolbars —
 * the ISS-9216 seam class this whole wave exists to close.
 */
export function AgentsListSurfaceV2Toolbar({
  model,
}: {
  model: AgentsListSurfaceV2ViewModel;
}) {
  return (
    <>
      {/* FEA-4019 grew the strip to seven tabs, which no longer fits on the
          same line as the trailing controls at a default desktop width — a
          shared line strands the search and wraps the rest into a
          broken-looking second row. */}
      <AgentsTypeTabsRow
        onValueChange={model.onKindTabChange}
        value={model.activeKindTab}
      />

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-4 py-3">
        {/* Bound directly to `filters.search`, which stays live so the box never
            lags the keystroke; the bounded read settles the term downstream in
            the view model, where a keystroke costs a request rather than an
            in-memory pass. */}
        <div className="relative w-full min-w-[180px] sm:w-56">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            size={16}
          />
          <Input
            aria-label="Search components"
            className="pl-8"
            onChange={(event) =>
              model.onFiltersChange({
                ...model.filters,
                search: event.target.value,
              })
            }
            placeholder="Search by name"
            type="search"
            value={model.filters.search}
          />
        </div>

        <DateRangeFilter<AgentsTimeRange>
          ariaLabel="Time window"
          labels={AGENTS_TIME_RANGE_LABELS}
          onChange={model.onTimeRangeChange}
          ranges={AGENTS_TIME_RANGES}
          shortLabels={AGENTS_TIME_RANGE_SHORT_LABELS}
          value={model.timeRange}
        />

        <FilterPopover
          controller={NOOP_TABLE_FILTERS_CONTROLLER}
          viewModel={buildFacetOnlyFiltersViewModel(
            // `facets` carries per-option counts over the filtered set with the
            // UNWINDOWED org inventory as the value universe (FEA-3202), so
            // zero-count Owner/Source options stay visible as the window
            // narrows — and it was counted under the SAME source projection the
            // membership predicate uses (ISS-5009), because one reduction
            // produced both.
            agentComponentFilterFacetGroups(
              model.facets,
              model.filters,
              model.onFiltersChange
            )
          )}
        />

        <AgentsViewMenu
          groupBy={model.groupBy}
          onGroupByChange={model.onGroupByChange}
          onReset={model.onResetView}
          onToggleColumn={model.onToggleColumn}
          visibleColumns={model.visibleColumns}
        />
      </div>
    </>
  );
}

/**
 * The type-tab strip, with the ISS-4803 overflow gate resolved HERE.
 *
 * The gate picks between two whole strips rather than being handed to one as a
 * boolean: `AGENTS.md` -> Code Style, "One read site per feature flag", whose
 * remedy is that the flag branches at the site that reads it. `…Optional`
 * because this surface also mounts with no `FeatureFlagAdapterProvider` (a
 * story, a column-geometry test), where the honest default is the strip that
 * ships today — every tab on the track.
 */
function AgentsTypeTabsRow({
  onValueChange,
  value,
}: {
  onValueChange: (value: string) => void;
  value: string;
}) {
  const overflowMenuEnabled = useFeatureFlagEnabledOptional(
    AGENTS_TYPE_TAB_OVERFLOW_FEATURE_FLAG_KEY
  );

  if (overflowMenuEnabled) {
    return (
      <AgentsTypeTabStrip
        onValueChange={onValueChange}
        options={AGENTS_TYPE_TAB_OPTIONS}
        overflowMenuEnabled
        value={value}
      />
    );
  }
  return (
    <AgentsTypeTabStrip
      onValueChange={onValueChange}
      options={AGENTS_TYPE_TAB_OPTIONS}
      value={value}
    />
  );
}
