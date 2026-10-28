"use client";

// Grid Table v2 promotion candidate, copied from the approved Generic Artifact prototype.
// SUPERSEDED FORK despite the suffix: `active-filters-bar.tsx` is the champion
// (ISS-9341, scripts/lint/ledgers/filter-control-families-ledger.ts).

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@closedloop-ai/design-system/components/ui/filter-chip";
import { PlusIcon } from "lucide-react";
import {
  AssigneeFilterContent,
  DateFilterContent,
  FilterMenuContent,
  PriorityFilterContent,
  StatusFilterContent,
  TagsFilterContent,
} from "./filter-popover-v2";
import {
  formatRangeValue,
  isFilterMenuGroupActive,
} from "./filter-range-submenu-v2";
import type {
  FilterMenuGroup,
  TableDateFilterField,
  TableFilterCategory,
  TableFilterLabels,
  TableFiltersController,
  TableFiltersViewModel,
} from "./table-filters-v2";

type ActiveFiltersBarProps<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  controller: TableFiltersController<TStatus, TPriority>;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
};

const DEFAULT_LABELS: Required<
  Pick<TableFilterLabels, "addFilter" | "clearAll">
> = {
  addFilter: "Add filter",
  clearAll: "Clear all",
};

export function ActiveFiltersBar<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: ActiveFiltersBarProps<TStatus, TPriority>) {
  const labels = {
    ...DEFAULT_LABELS,
    ...viewModel.labels,
  };

  const visibleChips = controller.activeChips.filter(
    (chip) =>
      (!viewModel.hideAssignee || chip.category !== "assignee") &&
      ((viewModel.showTags ?? true) || chip.category !== "tags")
  );
  // Chips for host-defined facets, from BOTH facet lists.
  //
  // `facetGroups` was previously ignored here, which meant the chip row was
  // structurally unreachable for the surfaces that most need it: `facetGroups`
  // REPLACES the built-in assignee/status/priority/date/tag controls, so a
  // toolbar driving its filters that way (Sessions and Branches both do, each
  // with a no-op controller) contributed no `activeChips` either — and the bar
  // rendered nothing but its own "Clear all". The two lists differ only in
  // whether the built-in controls survive alongside them; neither says anything
  // about whether an active filter deserves naming and a way out.
  const activeHostFacets = [
    ...(viewModel.facetGroups ?? []),
    ...(viewModel.additionalFacetGroups ?? []),
  ].filter(isFilterMenuGroupActive);

  // Deliberately NO "nothing is filtered, render nothing" guard here. Whether
  // this row should mount is the HOST's decision and cannot be made from inside:
  // the only production host gates on `filtersActive`, which counts an explicit
  // date window, a search term and an owner scope — none of which reaches this
  // component. A leaf-level guard therefore cannot tell "nothing to clear" from
  // "a narrower I cannot see", and the version that tried deleted the only
  // "Clear all" on a windowed Sessions list (ISS-8909, caught by
  // `v2-custom-window-url-seam`).

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
      {visibleChips.map((chip) => (
        <FilterChip
          dropdownClassName={chip.category === "assignee" ? "w-64" : undefined}
          key={chip.category}
          label={chip.label}
          onRemove={() => controller.clearCategoryFilter(chip.category)}
        >
          {chip.category !== "hideCompleted" &&
            chip.category !== "favorites" && (
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
        <FilterMenuContent controller={controller} viewModel={viewModel} />
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
      return (
        <AssigneeFilterContent controller={controller} viewModel={viewModel} />
      );
    case "status":
      return (
        <StatusFilterContent controller={controller} viewModel={viewModel} />
      );
    case "priority":
      return (
        <PriorityFilterContent controller={controller} viewModel={viewModel} />
      );
    case "date":
      return <DateFilterContent controller={controller} field={dateField} />;
    case "tags":
      return (
        <TagsFilterContent controller={controller} viewModel={viewModel} />
      );
    default:
      return null;
  }
}
