"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import {
  TableGridHeader,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
import { cn } from "@repo/design-system/lib/utils";
import { CalendarIcon, EllipsisIcon } from "lucide-react";
import { type ProjectRow, projects } from "../mock";

// Mirrors getDocumentRowGridTemplateColumns(4) from the live projects table:
// a flexible name track, one 124px track per visible property column, and the
// 88px trailing More-menu column.
const GRID_TEMPLATE_COLUMNS = "minmax(350px, 1fr) 124px 124px 124px 124px 88px";

// Standard fixed-width property cell box (matches @repo/app CELL_CLASSES).
const CELL_CLASSES =
  "flex h-full min-h-11 w-[124px] shrink-0 items-center border-l px-3 py-2";

const CELL_LABEL = "truncate font-medium text-muted-foreground text-xs";

const PRIORITY_LABELS: Record<ProjectRow["priority"], string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

const HEADER_COLUMNS: readonly TableGridHeaderColumn[] = [
  { id: "priority", label: "Priority", sortable: true },
  { id: "assignee", label: "Assignee", sortable: true },
  { id: "dueDate", label: "Due Date", sortable: true },
  { id: "updated", label: "Updated", sortable: true },
];

// Deterministic completion value for the name-cell status ring so the mock
// rows show a believable spread without carrying a hand-authored field.
const COMPLETION_BUCKETS = [0, 20, 45, 70, 100] as const;
const completionFor = (row: ProjectRow): number => {
  let sum = 0;
  for (const char of row.id) {
    sum += char.charCodeAt(0);
  }
  return COMPLETION_BUCKETS[sum % COMPLETION_BUCKETS.length];
};

const NameCell = ({ row }: { row: ProjectRow }) => (
  <div className="flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-2">
    {row.depth ? (
      <div
        aria-hidden="true"
        className="shrink-0"
        style={{ width: row.depth * 28 }}
      />
    ) : null}
    <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
      {row.code ?? ""}
    </span>
    <div className="flex h-7 w-7 shrink-0 items-center justify-center">
      <StatusPercentageIcon size={16} value={completionFor(row)} />
    </div>
    <span className="ml-1.5 min-w-0 flex-1 truncate font-medium text-sm">
      {row.name}
    </span>
  </div>
);

const PriorityCell = ({ row }: { row: ProjectRow }) => (
  <div className={cn(CELL_CLASSES, "gap-0")}>
    <div className="flex shrink-0 items-center p-2">
      <PriorityIcon priority={row.priority} />
    </div>
    <span className={CELL_LABEL}>{PRIORITY_LABELS[row.priority]}</span>
  </div>
);

const AssigneeCell = ({ row }: { row: ProjectRow }) => (
  <div className={cn(CELL_CLASSES, "gap-0")}>
    <div className="flex shrink-0 items-center justify-center p-1.5">
      {row.assignee ? (
        <Avatar className="size-5">
          <AvatarFallback
            className="text-[9px] text-white"
            style={{ backgroundColor: row.assignee.accent }}
          >
            {row.assignee.initials}
          </AvatarFallback>
        </Avatar>
      ) : (
        <div className="size-5 rounded-full border border-muted-foreground/40 border-dashed" />
      )}
    </div>
    {row.assignee ? (
      <span className={CELL_LABEL}>{row.assignee.name}</span>
    ) : null}
  </div>
);

const DueDateCell = ({ row }: { row: ProjectRow }) => (
  <div className={cn(CELL_CLASSES, "gap-0")}>
    <div className="flex w-8 shrink-0 items-center justify-center py-2">
      <CalendarIcon className="h-4 w-4 text-muted-foreground" />
    </div>
    <span className={CELL_LABEL}>{row.dueDate ?? "—"}</span>
  </div>
);

const UpdatedCell = ({ row }: { row: ProjectRow }) => (
  <div className={CELL_CLASSES}>
    <span className={CELL_LABEL}>{row.updated}</span>
  </div>
);

const MoreCell = () => (
  <div className="flex h-full min-h-11 items-center border-l px-1 py-2">
    <button
      aria-label="More actions"
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/row:opacity-100"
      type="button"
    >
      <EllipsisIcon className="h-4 w-4" />
    </button>
  </div>
);

export const ProjectsTable = () => (
  <div className="min-w-fit">
    <TableGridHeader
      columns={HEADER_COLUMNS}
      gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
      leadingSortKey="title"
      onSort={() => undefined}
      sortBy="title"
      sortDir="asc"
      // Explicit trailing header cell for the 88px More-menu column, matching
      // the live DocumentTableHeader.
      trailingCell={<div className="h-10 border-l" />}
    />
    {projects.map((row) => (
      <div
        className="group/row relative grid min-h-11 min-w-fit bg-background hover:bg-muted/40"
        key={row.id}
        style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-b" />
        <div>
          <NameCell row={row} />
        </div>
        <div>
          <PriorityCell row={row} />
        </div>
        <div>
          <AssigneeCell row={row} />
        </div>
        <div>
          <DueDateCell row={row} />
        </div>
        <div>
          <UpdatedCell row={row} />
        </div>
        <MoreCell />
      </div>
    ))}
  </div>
);
