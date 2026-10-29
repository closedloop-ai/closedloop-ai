"use client";

import { ListSurfaceToolbar } from "@repo/app/shared/components/list-surface-toolbar";
import {
  buildColumnOptions,
  buildMetricOptions,
  buildToolbarSortGrouping,
  toggleSetValue,
} from "@repo/app/shared/components/table-toolbar-controls";
import { Button } from "@repo/design-system/components/ui/button";
import { RangeSubmenu } from "@repo/design-system/components/ui/filter-range-submenu";
import type { TableDateRangeOption } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import { PlusIcon } from "lucide-react";
import {
  ARTIFACT_CUSTOM_FIELD_CAPABILITIES,
  ArtifactSavedViewsMenu,
} from "./artifact-list-control-adapters";
import { DATE_RANGES } from "./artifact-list-model";
import type { ArtifactListHostRendering } from "./artifact-list-shell-content";
import type { useGenericArtifactListController } from "./artifact-list-shell-controller";

type ArtifactListShellController = ReturnType<
  typeof useGenericArtifactListController
> & { host?: ArtifactListHostRendering };

const ARTIFACT_DATE_RANGE_OPTIONS: readonly TableDateRangeOption[] =
  DATE_RANGES.map((range) => ({
    label: range.label,
    shortLabel: range.value === "all" ? "All" : range.value,
    value: range.value,
  }));

/**
 * ISS-13007: the Documents / Issues / project-detail list toolbar under
 * `gridview-adoption`, handed to the one shared list toolbar. This maps the
 * artifact controller onto that toolbar's fields and callbacks; it owns no
 * layout of its own.
 */
export function ArtifactListSharedToolbar({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  const {
    activeSavedViewId,
    applySavedView,
    configuredColumns,
    customFields,
    dateDimension,
    dateFilterLabel,
    filterController,
    filterMenuOpen,
    filterViewModel,
    filtersActive,
    groupBy,
    groupOrder,
    layout,
    saveCurrentView,
    savedViews,
    secondaryGroupBy,
    secondaryGroupOrder,
    setAddArtifactOpen,
    setAddFieldOpen,
    setArtifactListLayout,
    setCustomFieldFilters,
    setExtensionFilters,
    setFilterMenuOpen,
    setGroupBy,
    setGroupOrder,
    setPage,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
    setShowEmptyGroups,
    setShowEmptySubgroups,
    setSortActive,
    setSortBy,
    setSortDir,
    setVisibleColumnIds,
    setVisibleMetricKeys,
    showAddArtifactButton,
    showAddFieldButton,
    showEmptyGroups,
    showEmptySubgroups,
    sortActive,
    sortBy,
    summaryMetricDefinitions,
    variant,
    visibleColumnIds,
    visibleMetricKeys,
  } = controller;
  const renderRangeSubmenu = (
    group: Parameters<typeof RangeSubmenu>[0]["group"],
    clearLabel: string
  ) => <RangeSubmenu clearLabel={clearLabel} group={group} />;
  return (
    <ListSurfaceToolbar
      columns={buildColumnOptions(configuredColumns, customFields)}
      dateRange={dateDimension.present ? dateDimension.range : undefined}
      dateRangeLabel={dateFilterLabel}
      dateRangeOptions={ARTIFACT_DATE_RANGE_OPTIONS}
      filterController={filterController}
      filterMenu={{
        onOpenChange: setFilterMenuOpen,
        open: filterMenuOpen,
        renderRangeSubmenu,
      }}
      filtersActive={filtersActive}
      filterViewModel={filterViewModel}
      framed
      layoutToggle={
        variant === "page"
          ? { onChange: setArtifactListLayout, value: layout }
          : undefined
      }
      metrics={buildMetricOptions(summaryMetricDefinitions)}
      onAddField={showAddFieldButton ? () => setAddFieldOpen(true) : undefined}
      onClearFilters={() => {
        filterController.clearAllFilters();
        setCustomFieldFilters({});
        setExtensionFilters({});
      }}
      onDateRangeChange={
        dateDimension.present
          ? (value) => {
              dateDimension.setRange(value);
              setPage(0);
            }
          : undefined
      }
      onToggleColumn={(key) => toggleSetValue(setVisibleColumnIds, key)}
      onToggleMetric={(key) => toggleSetValue(setVisibleMetricKeys, key)}
      savedViews={
        <ArtifactSavedViewsMenu
          activeViewId={activeSavedViewId}
          onApply={applySavedView}
          onSave={saveCurrentView}
          views={savedViews}
        />
      }
      search={controller.host?.search}
      sortGrouping={buildToolbarSortGrouping({
        columns: configuredColumns,
        customFieldCapabilities: ARTIFACT_CUSTOM_FIELD_CAPABILITIES,
        customFields,
        groupBy,
        groupOrder,
        onClearSort: () => {
          setSortActive(false);
          setSortBy("name");
          setSortDir("asc");
        },
        onSort: (column, direction) => {
          setSortActive(true);
          setSortBy(column);
          setSortDir(direction);
        },
        secondaryGroupBy,
        secondaryGroupOrder,
        setGroupBy,
        setGroupOrder,
        setSecondaryGroupBy,
        setSecondaryGroupOrder,
        setShowEmptyGroups,
        setShowEmptySubgroups,
        showEmptyGroups,
        showEmptySubgroups,
        sortActive,
        sortBy,
      })}
      trailing={
        showAddArtifactButton ? (
          <Button onClick={() => setAddArtifactOpen(true)} size="sm">
            <PlusIcon />
            Add artifact
          </Button>
        ) : null
      }
      visibleColumnIds={visibleColumnIds}
      visibleMetricKeys={visibleMetricKeys}
    />
  );
}
