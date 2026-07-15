"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@closedloop-ai/design-system/components/ui/filter-chip";
import { PlusIcon } from "lucide-react";
import {
  FilterMenuContent,
  AssigneeFilterContent,
  DateFilterContent,
  PriorityFilterContent,
  StatusFilterContent,
  TagsFilterContent,
} from "./filter-popover";
import type {
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

const DEFAULT_LABELS: Required<Pick<TableFilterLabels, "addFilter" | "clearAll">> =
  {
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

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
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
              viewModel={viewModel}
            />
          )}
        </FilterChip>
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
        onClick={controller.clearAllFilters}
        variant="ghost"
      >
        {labels.clearAll}
      </Button>
    </div>
  );
}

function ChipDropdownContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  category,
  controller,
  viewModel,
}: {
  category: Extract<
    TableFilterCategory,
    "assignee" | "status" | "priority" | "date" | "tags"
  >;
  controller: TableFiltersController<TStatus, TPriority>;
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
      return <DateFilterContent controller={controller} />;
    case "tags":
      return <TagsFilterContent controller={controller} viewModel={viewModel} />;
    default:
      return null;
  }
}
