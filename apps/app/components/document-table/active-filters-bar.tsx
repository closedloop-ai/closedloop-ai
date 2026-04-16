"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { PlusIcon } from "lucide-react";
import { FilterChip } from "@/components/filter-chip";
import type { TableFiltersReturn } from "@/hooks/use-table-filters";
import {
  AssigneeFilterContent,
  DateFilterContent,
  FilterMenuContent,
  PriorityFilterContent,
  StatusFilterContent,
} from "./filter-popover";

type ActiveFiltersBarProps = {
  currentUser?: { id: string; name: string; avatarUrl?: string } | null;
  filtersReturn: TableFiltersReturn;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  /** Hide assignee-related filter chips and submenu. */
  hideAssignee?: boolean;
};

export function ActiveFiltersBar({
  currentUser,
  filtersReturn,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  hideAssignee,
}: ActiveFiltersBarProps) {
  const { activeChips, clearCategoryFilter, clearAllFilters } = filtersReturn;
  const visibleChips = hideAssignee
    ? activeChips.filter((c) => c.category !== "assignee")
    : activeChips;

  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
      {visibleChips.map((chip) => (
        <FilterChip
          dropdownClassName={chip.category === "assignee" ? "w-64" : undefined}
          key={chip.category}
          label={chip.label}
          onRemove={() => clearCategoryFilter(chip.category)}
        >
          <ChipDropdownContent
            category={chip.category}
            filtersReturn={filtersReturn}
            teamMembers={teamMembers}
            teamMembersError={teamMembersError}
            teamMembersLoading={teamMembersLoading}
          />
        </FilterChip>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Add filter"
            className="inline-flex items-center self-stretch rounded-md border px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            type="button"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <FilterMenuContent
          currentUser={currentUser}
          filtersReturn={filtersReturn}
          hideAssignee={hideAssignee}
          teamMembers={teamMembers}
          teamMembersError={teamMembersError}
          teamMembersLoading={teamMembersLoading}
        />
      </DropdownMenu>
      <Button
        className="h-auto px-2 py-1 text-xs"
        onClick={clearAllFilters}
        variant="ghost"
      >
        Clear all
      </Button>
    </div>
  );
}

function ChipDropdownContent({
  category,
  filtersReturn,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
}: {
  category: "assignee" | "status" | "priority" | "date";
  filtersReturn: TableFiltersReturn;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
}) {
  switch (category) {
    case "assignee":
      return (
        <AssigneeFilterContent
          assigneeCounts={filtersReturn.assigneeCounts}
          filters={filtersReturn.filters}
          teamMembers={teamMembers}
          teamMembersError={teamMembersError}
          teamMembersLoading={teamMembersLoading}
          toggleAssignee={filtersReturn.toggleAssignee}
        />
      );
    case "status":
      return (
        <StatusFilterContent
          filters={filtersReturn.filters}
          statusCounts={filtersReturn.statusCounts}
          toggleStatus={filtersReturn.toggleStatus}
        />
      );
    case "priority":
      return (
        <PriorityFilterContent
          filters={filtersReturn.filters}
          priorityCounts={filtersReturn.priorityCounts}
          togglePriority={filtersReturn.togglePriority}
        />
      );
    case "date":
      return (
        <DateFilterContent
          filters={filtersReturn.filters}
          setDateFilter={filtersReturn.setDateFilter}
        />
      );
    default:
      return null;
  }
}
