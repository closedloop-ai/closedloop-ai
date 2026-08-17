"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { PlusIcon } from "lucide-react";
import {
  AssigneeFilterContent,
  DateFilterContent,
  FilterMenuContent,
  PriorityFilterContent,
  StatusFilterContent,
  TagsFilterContent,
} from "./filter-popover";
import type {
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
  const activeAdditionalFacets =
    viewModel.additionalFacetGroups?.filter((group) =>
      group.kind === "range"
        ? group.min !== undefined || group.max !== undefined
        : group.selectedValues.length > 0
    ) ?? [];

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
      {activeAdditionalFacets.map((group) => (
        <FilterChip
          key={group.id}
          label={additionalFacetLabel(group)}
          onRemove={() => clearAdditionalFacet(group)}
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
          for (const group of activeAdditionalFacets) {
            clearAdditionalFacet(group);
          }
        }}
        variant="ghost"
      >
        {labels.clearAll}
      </Button>
    </div>
  );
}

function additionalFacetLabel(
  group: NonNullable<TableFiltersViewModel["additionalFacetGroups"]>[number]
): string {
  if (group.kind === "range") {
    const bounds = [group.min, group.max]
      .map((value) => value?.toString() ?? "")
      .join("–");
    return `${group.label}: ${bounds}`;
  }
  const selectedLabels = group.options
    .filter((option) => group.selectedValues.includes(option.id))
    .map((option) => option.label);
  return `${group.label}: ${selectedLabels.join(", ")}`;
}

function clearAdditionalFacet(
  group: NonNullable<TableFiltersViewModel["additionalFacetGroups"]>[number]
) {
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
