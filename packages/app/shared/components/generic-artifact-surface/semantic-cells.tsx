"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  TablePriorityCell,
  type TablePriority as TablePriorityValue,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import {
  PRIORITY_VALUES_HIGHEST_FIRST,
  priorityLabel,
} from "@repo/design-system/lib/priority-order";

export function EditablePriorityTableCell({
  onChange,
  priority,
}: {
  onChange: (priority: TablePriorityValue) => void;
  priority: TablePriorityValue;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit priority, currently ${priorityLabel(priority)}`}
          className="flex w-full min-w-0 items-center rounded-md px-1 py-0.5 text-left hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          <TablePriorityCell priority={priority} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Priority</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => onChange(value as TablePriorityValue)}
          value={priority}
        >
          {PRIORITY_VALUES_HIGHEST_FIRST.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <TablePriorityCell priority={option} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
