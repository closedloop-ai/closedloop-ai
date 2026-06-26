"use client";

import type { Priority } from "@repo/api/src/types/common";
import { CellTooltip } from "@repo/app/documents/components/table/cells/cell-tooltip";
import { CELL_CLASSES } from "@repo/app/documents/components/table/cells/shared-cell-styles";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { ensureDate, formatDateCompact } from "@repo/app/shared/lib/date-utils";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import { CalendarIcon } from "lucide-react";
import { useContext } from "react";

/**
 * Inline-edit column cells: due date, assignee, and priority (FEA-1763 /
 * PLN-874 Phase 3; extracted from document-row.tsx). Rows whose registry
 * config is `editable: false` render a read-only dash.
 */

export function DueDateCell({ item }: { item: DocumentRowItem }) {
  const { onUpdateDueDate } = useContext(RowEditContext);
  if (getRowTypeConfig(item)?.editable === false) {
    return (
      <div className={cn(CELL_CLASSES, "text-muted-foreground text-xs")}>—</div>
    );
  }
  // Projects use targetDate; artifacts/features use updatedAt as a placeholder
  const date =
    item.kind === "project"
      ? ensureDate(item.data.targetDate)
      : ensureDate(item.data.updatedAt);

  const trigger = (
    <button
      className={cn(CELL_CLASSES, "gap-0 hover:bg-muted/50")}
      onClick={(e) => e.stopPropagation()}
      type="button"
    >
      <div className="flex w-8 shrink-0 items-center justify-center py-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {date ? formatDateCompact(date) : "—"}
      </span>
    </button>
  );

  if (!onUpdateDueDate) {
    return (
      <div className={cn(CELL_CLASSES, "gap-0")}>
        <div className="flex w-8 shrink-0 items-center justify-center py-2">
          <CalendarIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {date ? formatDateCompact(date) : "—"}
        </span>
      </div>
    );
  }

  return (
    <DatePickerPopover
      onSelect={(d) => onUpdateDueDate(item.data.id, d)}
      trigger={trigger}
      value={date}
    />
  );
}

export function AssigneeCell({ item }: { item: DocumentRowItem }) {
  const { onUpdateAssignee, teamMembers } = useContext(RowEditContext);
  if (getRowTypeConfig(item)?.editable === false) {
    return (
      <div className={cn(CELL_CLASSES, "text-muted-foreground text-xs")}>—</div>
    );
  }
  const assignee = item.data.assignee ?? null;
  const assigneeLabel = assignee ? getUserDisplayName(assignee) : "Unassigned";

  const trigger = (
    <button
      className={cn(CELL_CLASSES, "gap-0 hover:bg-muted/50")}
      onClick={(e) => e.stopPropagation()}
      type="button"
    >
      <div className="flex shrink-0 items-center justify-center p-1.5">
        <AssigneeAvatar
          assignee={assignee}
          className="size-5"
          disableLink
          disableTooltip
        />
      </div>
      {assignee && (
        <span className="truncate font-medium text-muted-foreground text-xs">
          {assignee.firstName} {assignee.lastName}
        </span>
      )}
    </button>
  );

  if (!(onUpdateAssignee && teamMembers)) {
    return (
      <CellTooltip text={assigneeLabel}>
        <div className={cn(CELL_CLASSES, "gap-0")}>
          <div className="flex shrink-0 items-center justify-center p-1.5">
            <AssigneeAvatar
              assignee={assignee}
              className="size-5"
              disableLink
              disableTooltip
            />
          </div>
          {assignee && (
            <span className="truncate font-medium text-muted-foreground text-xs">
              {assignee.firstName} {assignee.lastName}
            </span>
          )}
        </div>
      </CellTooltip>
    );
  }

  return (
    <CellTooltip text={assigneeLabel}>
      <div className="h-full min-h-11 w-[124px] shrink-0">
        <UserSelectPopover
          onSelect={(user) => onUpdateAssignee(item.data.id, user?.id ?? null)}
          trigger={trigger}
          users={teamMembers}
          value={
            assignee
              ? {
                  id: assignee.id,
                  name: getUserDisplayName(assignee),
                  avatarUrl: assignee.avatarUrl || undefined,
                }
              : null
          }
        />
      </div>
    </CellTooltip>
  );
}

export function PriorityCell({ item }: { item: DocumentRowItem }) {
  const { onUpdatePriority } = useContext(RowEditContext);
  if (getRowTypeConfig(item)?.editable === false) {
    return (
      <div className={cn(CELL_CLASSES, "text-muted-foreground text-xs")}>—</div>
    );
  }
  const priority = item.data.priority ?? null;

  if (!onUpdatePriority) {
    if (!priority) {
      return (
        <div className={CELL_CLASSES}>
          <span className="font-medium text-muted-foreground text-xs">—</span>
        </div>
      );
    }
    return (
      <div className={cn(CELL_CLASSES, "gap-0")}>
        <div className="flex shrink-0 items-center p-2">
          <PriorityIcon priority={priority} />
        </div>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {PRIORITY_LABELS[priority]}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(CELL_CLASSES, "gap-0 hover:bg-muted/50")}
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          {priority ? (
            <>
              <div className="flex shrink-0 items-center p-2">
                <PriorityIcon priority={priority} />
              </div>
              <span className="truncate font-medium text-muted-foreground text-xs">
                {PRIORITY_LABELS[priority]}
              </span>
            </>
          ) : (
            <span className="font-medium text-muted-foreground text-xs">—</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
          <DropdownMenuItem
            key={value}
            onClick={(e) => {
              e.stopPropagation();
              onUpdatePriority(item.data.id, value as Priority);
            }}
          >
            <PriorityIcon priority={value as Priority} />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
