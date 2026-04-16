"use client";

import { Priority } from "@repo/api/src/types/common";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import {
  CalendarIcon,
  CheckIcon,
  ListFilterIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import {
  DATE_PRESET_LABELS,
  DateFilterField,
  DatePreset,
  getStatusesForCategory,
  type TableFiltersReturn,
} from "@/hooks/use-table-filters";
import {
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_STATUS_TO_ICON,
  PRIORITY_LABELS,
} from "@/lib/project-constants";
import { getInitials } from "@/lib/user-utils";

// ---- Props ----

type FilterPopoverProps = {
  filtersReturn: TableFiltersReturn;
  currentUser?: { id: string; name: string; avatarUrl?: string } | null;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  /** Hide the "Assigned to me" quick action and Assignee submenu. */
  hideAssignee?: boolean;
};

const DATE_PRESETS_ORDER: DatePreset[] = [
  DatePreset.Last24h,
  DatePreset.Last7d,
  DatePreset.Last30d,
  DatePreset.Last3m,
];

// ---- Main component ----

export function FilterPopover({
  filtersReturn,
  currentUser,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  hideAssignee,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Filter artifacts"
          className="h-8 shadow-none"
          size="sm"
          variant="outline"
        >
          <ListFilterIcon />
          Filter
        </Button>
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
  );
}

// ---- Shared menu content (used by FilterPopover and the add-filter button) ----

export function FilterMenuContent({
  filtersReturn,
  currentUser,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  hideAssignee,
}: FilterPopoverProps) {
  const {
    filters,
    toggleAssignee,
    toggleAssignToMe,
    toggleStatus,
    togglePriority,
    setDateFilter,
    assigneeCounts,
    statusCounts,
    priorityCounts,
  } = filtersReturn;

  const assigneeTotal = filters.assigneeIds.length;
  const statusTotal = filters.statuses.length;
  const priorityTotal = filters.priorities.length;

  return (
    <DropdownMenuContent align="start" className="w-52">
      {!hideAssignee && currentUser && (
        <>
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                toggleAssignToMe();
              }}
            >
              <Avatar className="size-5">
                {currentUser.avatarUrl && (
                  <AvatarImage src={currentUser.avatarUrl} />
                )}
                <AvatarFallback className="text-[10px]">
                  {getInitials(currentUser.name)}
                </AvatarFallback>
              </Avatar>
              <span className={cn(filters.assignToMe && "font-medium")}>
                Assigned to me
              </span>
              {filters.assignToMe && <CheckIcon className="ml-auto size-4" />}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuGroup>
        {!hideAssignee && (
          <AssigneeSubmenu
            assigneeCounts={assigneeCounts}
            assigneeTotal={assigneeTotal}
            filters={filters}
            teamMembers={teamMembers}
            teamMembersError={teamMembersError}
            teamMembersLoading={teamMembersLoading}
            toggleAssignee={toggleAssignee}
          />
        )}
        <StatusSubmenu
          filters={filters}
          statusCounts={statusCounts}
          statusTotal={statusTotal}
          toggleStatus={toggleStatus}
        />
        <PrioritySubmenu
          filters={filters}
          priorityCounts={priorityCounts}
          priorityTotal={priorityTotal}
          togglePriority={togglePriority}
        />
        <DatesSubmenu filters={filters} setDateFilter={setDateFilter} />
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

// ---- Exported content components (reused in filter chips) ----

export function AssigneeFilterContent({
  filters,
  toggleAssignee,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  assigneeCounts,
}: {
  filters: TableFiltersReturn["filters"];
  toggleAssignee: (id: string) => void;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  assigneeCounts: Map<string, number>;
}) {
  const [search, setSearch] = useState("");
  const filtered = teamMembers.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <SubMenuSearch onChange={setSearch} value={search} />
      {teamMembersLoading && (
        <div className="p-4 text-center text-muted-foreground text-sm">
          Loading...
        </div>
      )}
      {teamMembersError && (
        <div className="p-4 text-center text-muted-foreground text-sm">
          Could not load members
        </div>
      )}
      {!(teamMembersLoading || teamMembersError) && (
        <>
          <FilterRow
            checked={filters.assigneeIds.includes("__unassigned__")}
            onToggle={() => toggleAssignee("__unassigned__")}
          >
            <div className="flex size-5 items-center justify-center">
              <UserIcon className="size-4 text-muted-foreground" />
            </div>
            <span
              className={cn(
                "flex-1 truncate",
                filters.assigneeIds.includes("__unassigned__") && "font-medium"
              )}
            >
              Unassigned
            </span>
            <span className="text-muted-foreground text-xs">
              {assigneeCounts.get("__unassigned__") ?? 0}
            </span>
          </FilterRow>
          {filtered.map((member) => {
            const checked = filters.assigneeIds.includes(member.id);
            return (
              <FilterRow
                checked={checked}
                key={member.id}
                onToggle={() => toggleAssignee(member.id)}
              >
                <Avatar className="size-5">
                  {member.avatarUrl && <AvatarImage src={member.avatarUrl} />}
                  <AvatarFallback className="text-[10px]">
                    {getInitials(member.name)}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    checked && "font-medium"
                  )}
                >
                  {member.name}
                </span>
                <span className="text-muted-foreground text-xs">
                  {assigneeCounts.get(member.id) ?? 0}
                </span>
              </FilterRow>
            );
          })}
        </>
      )}
    </>
  );
}

export function StatusFilterContent({
  filters,
  toggleStatus,
  statusCounts,
}: {
  filters: TableFiltersReturn["filters"];
  toggleStatus: (status: string) => void;
  statusCounts: Map<string, number>;
}) {
  const [search, setSearch] = useState("");
  const statuses = getStatusesForCategory();
  const filtered = statuses.filter((s) =>
    ARTIFACT_STATUS_LABELS[s].toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <SubMenuSearch onChange={setSearch} value={search} />
      {filtered.map((status) => {
        const checked = filters.statuses.includes(status);
        return (
          <FilterRow
            checked={checked}
            key={status}
            onToggle={() => toggleStatus(status)}
          >
            <StatusIcon size={16} status={ARTIFACT_STATUS_TO_ICON[status]} />
            <span className={cn("flex-1", checked && "font-medium")}>
              {ARTIFACT_STATUS_LABELS[status]}
            </span>
            <span className="text-muted-foreground text-xs">
              {statusCounts.get(status) ?? 0}
            </span>
          </FilterRow>
        );
      })}
    </>
  );
}

export function PriorityFilterContent({
  filters,
  togglePriority,
  priorityCounts,
}: {
  filters: TableFiltersReturn["filters"];
  togglePriority: (p: Priority) => void;
  priorityCounts: Map<Priority, number>;
}) {
  const [search, setSearch] = useState("");
  const filtered = PRIORITY_ORDER.filter((p) =>
    PRIORITY_LABELS[p].toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <SubMenuSearch onChange={setSearch} value={search} />
      {filtered.map((priority) => {
        const checked = filters.priorities.includes(priority);
        return (
          <FilterRow
            checked={checked}
            key={priority}
            onToggle={() => togglePriority(priority)}
          >
            <PriorityIcon priority={priority} size={16} />
            <span className={cn("flex-1", checked && "font-medium")}>
              {PRIORITY_LABELS[priority]}
            </span>
            <span className="text-muted-foreground text-xs">
              {priorityCounts.get(priority) ?? 0}
            </span>
          </FilterRow>
        );
      })}
    </>
  );
}

export function DateFilterContent({
  filters,
  setDateFilter,
}: {
  filters: TableFiltersReturn["filters"];
  setDateFilter: (d: TableFiltersReturn["filters"]["date"]) => void;
}) {
  const field = filters.date?.field ?? DateFilterField.CreatedAt;
  const currentPreset = filters.date?.preset ?? null;

  return (
    <>
      {DATE_PRESETS_ORDER.map((preset) => {
        const selected = currentPreset === preset;
        return (
          <DropdownMenuItem
            key={preset}
            onSelect={() => {
              if (currentPreset === preset) {
                setDateFilter(null);
              } else {
                setDateFilter({ field, preset });
              }
            }}
          >
            <span className={cn("flex-1", selected && "font-medium")}>
              {DATE_PRESET_LABELS[preset]}
            </span>
            {selected && <CheckIcon className="ml-auto size-4" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

// ---- Submenu wrappers (internal, used by FilterPopover) ----

function AssigneeSubmenu({
  filters,
  toggleAssignee,
  teamMembers,
  teamMembersLoading,
  teamMembersError,
  assigneeCounts,
  assigneeTotal,
}: {
  filters: TableFiltersReturn["filters"];
  toggleAssignee: (id: string) => void;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  assigneeCounts: Map<string, number>;
  assigneeTotal: number;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <UsersIcon className="size-4" />
        <span className="flex-1">Assignee</span>
        {assigneeTotal > 0 && (
          <span className="text-muted-foreground text-xs">{assigneeTotal}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-64">
          <AssigneeFilterContent
            assigneeCounts={assigneeCounts}
            filters={filters}
            teamMembers={teamMembers}
            teamMembersError={teamMembersError}
            teamMembersLoading={teamMembersLoading}
            toggleAssignee={toggleAssignee}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function StatusSubmenu({
  filters,
  toggleStatus,
  statusCounts,
  statusTotal,
}: {
  filters: TableFiltersReturn["filters"];
  toggleStatus: (status: string) => void;
  statusCounts: Map<string, number>;
  statusTotal: number;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <StatusIcon size={16} status="decorative" />
        <span className="flex-1">Status</span>
        {statusTotal > 0 && (
          <span className="text-muted-foreground text-xs">{statusTotal}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-60">
          <StatusFilterContent
            filters={filters}
            statusCounts={statusCounts}
            toggleStatus={toggleStatus}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

const PRIORITY_ORDER: Priority[] = [
  Priority.Urgent,
  Priority.High,
  Priority.Medium,
  Priority.Low,
];

function PrioritySubmenu({
  filters,
  togglePriority,
  priorityCounts,
  priorityTotal,
}: {
  filters: TableFiltersReturn["filters"];
  togglePriority: (p: Priority) => void;
  priorityCounts: Map<Priority, number>;
  priorityTotal: number;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <PriorityIcon priority={Priority.High} size={16} />
        <span className="flex-1">Priority</span>
        {priorityTotal > 0 && (
          <span className="text-muted-foreground text-xs">{priorityTotal}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          <PriorityFilterContent
            filters={filters}
            priorityCounts={priorityCounts}
            togglePriority={togglePriority}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function DatesSubmenu({
  filters,
  setDateFilter,
}: {
  filters: TableFiltersReturn["filters"];
  setDateFilter: (d: TableFiltersReturn["filters"]["date"]) => void;
}) {
  const hasDateFilter = filters.date !== null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CalendarIcon className="size-4" />
        <span className="flex-1">Dates</span>
        {hasDateFilter && (
          <span className="text-muted-foreground text-xs">1</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-48">
          <DateFieldSubmenu
            field={DateFilterField.CreatedAt}
            filters={filters}
            label="Date Created"
            setDateFilter={setDateFilter}
          />
          <DateFieldSubmenu
            field={DateFilterField.UpdatedAt}
            filters={filters}
            label="Updated Date"
            setDateFilter={setDateFilter}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function DateFieldSubmenu({
  label,
  field,
  filters,
  setDateFilter,
}: {
  label: string;
  field: DateFilterField;
  filters: TableFiltersReturn["filters"];
  setDateFilter: (d: TableFiltersReturn["filters"]["date"]) => void;
}) {
  const isActive = filters.date?.field === field;
  const currentPreset = isActive ? filters.date?.preset : null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CalendarIcon className="size-4" />
        <span className="flex-1">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-44">
          {DATE_PRESETS_ORDER.map((preset) => {
            const selected = currentPreset === preset;
            return (
              <DropdownMenuItem
                key={preset}
                onSelect={() => {
                  if (currentPreset === preset) {
                    setDateFilter(null);
                  } else {
                    setDateFilter({ field, preset });
                  }
                }}
              >
                <span className={cn("flex-1", selected && "font-medium")}>
                  {DATE_PRESET_LABELS[preset]}
                </span>
                {selected && <CheckIcon className="ml-auto size-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

// ---- Shared: Search input for submenus ----

function SubMenuSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <div className="px-2 pt-0.5 pb-1.5">
        <input
          className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Filter..."
          type="text"
          value={value}
        />
      </div>
      <DropdownMenuSeparator className="mt-0 mb-1" />
    </>
  );
}

// ---- Shared: Filter row with checkbox + label ----

function FilterRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem className="gap-2" onSelect={() => onToggle()}>
      <button
        className="flex items-center"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        tabIndex={-1}
        type="button"
      >
        <Checkbox
          checked={checked}
          className="[&_svg]:!text-current pointer-events-none"
        />
      </button>
      {children}
    </DropdownMenuItem>
  );
}
