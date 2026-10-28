"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@closedloop-ai/design-system/components/ui/filter-chip";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  FilterMenuContent,
  AssigneeFilterContent,
  DateFilterContent,
  PriorityFilterContent,
  StatusFilterContent,
  TagsFilterContent,
} from "./filter-popover";
import {
  formatRangeValue,
  isFilterMenuGroupActive,
} from "./filter-range-submenu";
import type {
  FilterMenuGroup,
  FilterRangeGroup,
  TableDateFilterField,
  TableFilterCategory,
  TableFilterLabels,
  TableFiltersController,
  TableFiltersViewModel,
} from "./table-filters";

type ActiveFiltersBarProps<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  controller: TableFiltersController<TStatus, TPriority>;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
  /**
   * Chips a surface owns itself, rendered ahead of the managed facet chips so
   * the strip reads as one row of filters. For a narrowing that is a server
   * request parameter rather than a client-side facet — e.g. My Tasks' recency
   * window — which must still be visible and removable like any other filter.
   */
  extraChips?: ReactNode;
  /**
   * Whether the trailing add/clear controls render. Defaults to `true`, which is
   * every existing caller (they mount this bar only when a facet filter is
   * active). Pass `false` when the bar is on screen solely for {@link extraChips}
   * so a "Clear all" button never sits there with nothing to clear.
   */
  showFilterControls?: boolean;
  /** Forwarded to the add-filter menu, as `FilterPopover` takes it. */
  renderRangeSubmenu?: (
    group: FilterRangeGroup,
    clearLabel: string
  ) => ReactNode;
};

const DEFAULT_LABELS: Required<Pick<TableFilterLabels, "addFilter" | "clearAll">> =
  {
    addFilter: "Add filter",
    clearAll: "Clear all",
  };

/**
 * Whether the bar below has anything to show: a built-in chip it would render
 * or an active host facet. A host that hides the bar while nothing is filtered
 * asks this rather than re-deriving the answer, so the two cannot disagree.
 */
export function hasVisibleActiveFilters<
  TStatus extends string = string,
  TPriority extends string = string,
>(
  controller: TableFiltersController<TStatus, TPriority>,
  viewModel: TableFiltersViewModel<TStatus, TPriority>
): boolean {
  return (
    visibleActiveChips(controller, viewModel).length > 0 ||
    activeHostFacetGroups(viewModel).length > 0
  );
}

function visibleActiveChips<TStatus extends string, TPriority extends string>(
  controller: TableFiltersController<TStatus, TPriority>,
  viewModel: TableFiltersViewModel<TStatus, TPriority>
) {
  return controller.activeChips.filter(
    (chip) =>
      (!viewModel.hideAssignee || chip.category !== "assignee") &&
      ((viewModel.showTags ?? true) || chip.category !== "tags")
  );
}

// Both facet lists: `facetGroups` REPLACES the built-in controls, so a surface
// driving filters that way pairs it with a no-op controller and contributes no
// `activeChips` — reading only `additionalFacetGroups` leaves that half unnamed
// and unclearable.
function activeHostFacetGroups<
  TStatus extends string,
  TPriority extends string,
>(viewModel: TableFiltersViewModel<TStatus, TPriority>) {
  return [
    ...(viewModel.facetGroups ?? []),
    ...(viewModel.additionalFacetGroups ?? []),
  ].filter(isFilterMenuGroupActive);
}

export function ActiveFiltersBar<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  viewModel,
  extraChips,
  showFilterControls = true,
  renderRangeSubmenu,
}: ActiveFiltersBarProps<TStatus, TPriority>) {
  const labels = {
    ...DEFAULT_LABELS,
    ...viewModel.labels,
  };

  const visibleChips = visibleActiveChips(controller, viewModel);
  const activeHostFacets = activeHostFacetGroups(viewModel);

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
      {extraChips}
      {visibleChips.map((chip) => (
        <FilterChip
          dropdownClassName={chip.category === "assignee" ? "w-64" : undefined}
          key={chip.category}
          label={chip.label}
          onRemove={() => controller.clearCategoryFilter(chip.category)}
        >
          {chip.category !== "hideCompleted" && chip.category !== "favorites" && (
            <ChipDropdownContent
              category={chip.category}
              controller={controller}
              dateField={controller.filters.date?.field}
              viewModel={viewModel}
            />
          )}
        </FilterChip>
      ))}
      {activeHostFacets.map((group) => (
        <FilterChip
          // Namespaced: a host facet is free to use an id that matches a
          // built-in category name ("status"), and these two maps are siblings.
          key={`facet:${group.id}`}
          label={hostFacetLabel(group)}
          onRemove={() => clearHostFacet(group)}
        />
      ))}
      {showFilterControls && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={labels.addFilter}
                className="inline-flex items-center self-stretch rounded-md border px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                type="button"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <FilterMenuContent
              controller={controller}
              renderRangeSubmenu={renderRangeSubmenu}
              viewModel={viewModel}
            />
          </DropdownMenu>
          <Button
            className="h-auto px-2 py-1 text-xs"
            onClick={() => {
              controller.clearAllFilters();
              for (const group of activeHostFacets) {
                clearHostFacet(group);
              }
            }}
            variant="ghost"
          >
            {labels.clearAll}
          </Button>
        </>
      )}
    </div>
  );
}

/** "Status: Active, Blocked" / "Cost: 0 – 9" for one active host facet. */
function hostFacetLabel(group: FilterMenuGroup): string {
  if (group.kind === "range") {
    const value = formatRangeValue(group.min, group.max);
    if (value !== null) {
      return `${group.label}: ${value}`;
    }
    // Bounded but unrenderable, i.e. non-finite. Name the facet without
    // asserting a bound, so the chip's remove action still reaches it.
    return group.label;
  }
  const selectedLabels = group.options
    .filter((option) => group.selectedValues.includes(option.id))
    .map((option) => option.label);
  return `${group.label}: ${selectedLabels.join(", ")}`;
}

function clearHostFacet(group: FilterMenuGroup) {
  if (group.kind === "range") {
    group.onChange({});
    return;
  }
  for (const value of group.selectedValues) {
    group.onToggle(value);
  }
}

function ChipDropdownContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  category,
  controller,
  dateField,
  viewModel,
}: {
  category: Extract<
    TableFilterCategory,
    "assignee" | "status" | "priority" | "date" | "tags"
  >;
  controller: TableFiltersController<TStatus, TPriority>;
  dateField?: TableDateFilterField;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
}) {
  switch (category) {
    case "assignee":
      return <AssigneeFilterContent controller={controller} viewModel={viewModel} />;
    case "status":
      return <StatusFilterContent controller={controller} viewModel={viewModel} />;
    case "priority":
      return (
        <PriorityFilterContent controller={controller} viewModel={viewModel} />
      );
    case "date":
      return (
        <DateFilterContent controller={controller} field={dateField} />
      );
    case "tags":
      return <TagsFilterContent controller={controller} viewModel={viewModel} />;
    default:
      return null;
  }
}
