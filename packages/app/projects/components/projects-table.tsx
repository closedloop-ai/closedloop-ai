"use client";

import {
  ProductGridTableV2,
  type ProductGridTableV2SelectionProps,
} from "@repo/app/shared/components/product-grid-table-v2";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import type { TableGridHeaderActions } from "@repo/design-system/components/ui/table-grid-column-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  MIN_COLUMN_WIDTH_PX,
  orderColumns,
} from "@repo/design-system/lib/column-order";
import { priorityLabel } from "@repo/design-system/lib/priority-order";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { CalendarIcon, FolderKanbanIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  PROJECT_ROW_ACTIONS_COLUMN_ID,
  PROJECT_ROW_ACTIONS_COLUMN_WIDTH_PX,
  PROJECT_SUMMARY_COLUMN_IDS,
  PROJECT_SUMMARY_COLUMNS,
  PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
} from "../lib/project-summary-columns";
import {
  type ProjectSummaryOwner,
  type ProjectSummaryRow,
  projectCompletionLabel,
  projectCompletionValue,
} from "../lib/project-summary-row";
import type { ProjectSummaryGroup } from "../lib/project-summary-view";

const DEFAULT_COLUMN_WIDTHS: Readonly<Record<string, number>> =
  Object.fromEntries(
    PROJECT_SUMMARY_COLUMNS.map((column) => [
      column.id,
      column.width.default ?? MIN_COLUMN_WIDTH_PX,
    ])
  );
const DEFAULT_VISIBLE_COLUMN_IDS: ReadonlySet<string> = new Set(
  PROJECT_SUMMARY_COLUMN_IDS
);
const PROJECT_ROW_ACTIONS_COLUMN = {
  id: PROJECT_ROW_ACTIONS_COLUMN_ID,
  label: "",
  ariaLabel: "Row actions",
  width: { default: PROJECT_ROW_ACTIONS_COLUMN_WIDTH_PX },
} as const;

export type ProjectsTableProps = {
  readonly columnOrder?: readonly string[];
  readonly columnWidths?: Readonly<Record<string, number>>;
  /**
   * Whether the caller narrowed the rows it passed. This component receives
   * already-filtered rows, so it cannot tell "this team has no projects" from
   * "your filters matched none" — only the caller holds both facts.
   */
  readonly filtersActive?: boolean;
  /**
   * The host's own "there are none yet, make one" control. Optional because a
   * read-only host (the prototype) has no mutation to offer — but a host that
   * does must be able to put it here, or a team's very first view of Projects
   * is passive copy where the surface it replaced offered Create.
   */
  readonly emptyStateAction?: ReactNode;
  /** Words for the no-rows state; omitted, the shared default wording. */
  readonly emptyStateCopy?: ProjectsEmptyStateCopy;
  readonly getRowHref?: (row: ProjectSummaryRow) => string;
  readonly groups?: readonly ProjectSummaryGroup[];
  readonly headerActions?: TableGridHeaderActions;
  readonly leadingColumnWidth?: number;
  readonly onColumnOrderChange?: (nextOrder: string[]) => void;
  readonly onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  readonly onSort?: (column: string, direction: SortDirection) => void;
  /**
   * The host's own per-row project-management menu (archive, delete, favorite),
   * rendered into a trailing actions column. ABSENT MEANS NO COLUMN — a
   * read-only host has no mutations to offer, and a host that owns them must
   * pass them or its rows lose every write the surface they replace offered.
   */
  readonly rowActions?: (row: ProjectSummaryRow) => ReactNode;
  /**
   * The host's own inline editors for the Priority, Owner and Due Date columns.
   * A column with no editor renders the read-only value, which is the whole
   * contract for a read-only host; a host that owns the mutations passes one per
   * column and the cell becomes the control, the way the surface this one
   * replaces already offered.
   */
  readonly cellEditors?: ProjectCellEditors;
  readonly rows: readonly ProjectSummaryRow[];
  readonly selection?: ProductGridTableV2SelectionProps<ProjectSummaryRow>;
  readonly sortBy?: string;
  readonly sortDir?: SortDirection;
  readonly visibleColumnIds?: ReadonlySet<string>;
};

export function ProjectsTable({
  cellEditors,
  columnOrder = PROJECT_SUMMARY_COLUMN_IDS,
  columnWidths = DEFAULT_COLUMN_WIDTHS,
  emptyStateAction,
  emptyStateCopy,
  filtersActive = false,
  getRowHref,
  groups,
  headerActions,
  leadingColumnWidth = PROJECT_SUMMARY_LEADING_COLUMN_WIDTH_PX,
  onColumnOrderChange,
  onColumnWidthChange,
  onSort = () => undefined,
  rowActions,
  rows,
  selection,
  sortBy = "name",
  sortDir = "asc",
  visibleColumnIds = DEFAULT_VISIBLE_COLUMN_IDS,
}: ProjectsTableProps) {
  const navigation = useNavigation();
  const visibleColumns = PROJECT_SUMMARY_COLUMNS.filter((column) =>
    visibleColumnIds.has(column.id)
  );
  const orderedVisibleColumns = orderColumns(visibleColumns, columnOrder);
  // The actions column is appended rather than declared in
  // `PROJECT_SUMMARY_COLUMNS`, because that inventory is also what the sort,
  // group and options menus read: a menu offering "Row actions" as something to
  // sort or hide by is not a column the user has any business reordering.
  const renderedColumns = rowActions
    ? [...orderedVisibleColumns, PROJECT_ROW_ACTIONS_COLUMN]
    : orderedVisibleColumns;
  const gridTemplateColumns = `minmax(${leadingColumnWidth}px, 1fr) ${renderedColumns
    .map(
      (column) =>
        `${columnWidths[column.id] ?? column.width.default ?? MIN_COLUMN_WIDTH_PX}px`
    )
    .join(" ")}`;
  const displayedRows = groups
    ? groups.flatMap((group) =>
        group.subgroups
          ? group.subgroups.flatMap((subgroup) => subgroup.items)
          : group.items
      )
    : rows;
  const {
    enableRowRangeDrag,
    getCompatibilityCardSelectionLabel,
    isRowSelected,
    onRenderedItemsChange,
    onRowClick: onSelectionRowClick,
    onRowKeyboardNavigate,
    onRowRangeDrag,
    onRowSelectionToggle,
    onSelectAllRows,
  } = selection ?? {};

  if (displayedRows.length === 0) {
    return (
      <ProjectsEmptyState
        emptyStateAction={emptyStateAction}
        emptyStateCopy={emptyStateCopy}
        filtersActive={filtersActive}
      />
    );
  }

  // `GridTableV2.onRowClick` hands back the row only, so a modifier-click on the
  // row BACKGROUND cannot be distinguished here. New-tab activation lives on the
  // lead cell's real `Link` (which GridTableV2 leaves alone as an interactive
  // target), so cmd/ctrl-click on the project name still opens a new tab.
  const openProject = (row: ProjectSummaryRow) => {
    const href = getRowHref?.(row);
    if (!href) {
      return;
    }
    navigation.navigate(href);
  };

  return (
    <ProductGridTableV2
      cardCompatibility={{
        getSelectionLabel: getCompatibilityCardSelectionLabel,
        render: (row) => <ProjectCard getRowHref={getRowHref} row={row} />,
      }}
      columnOrder={columnOrder}
      columns={renderedColumns}
      columnWidths={columnWidths}
      enableRowRangeDrag={enableRowRangeDrag}
      getRowId={(row) => row.id}
      gridTemplateColumns={gridTemplateColumns}
      groups={groups ? [...groups] : undefined}
      headerActions={headerActions}
      isRowSelected={isRowSelected}
      items={[...rows]}
      leadingLabel="Project"
      leadingSortKey="name"
      onColumnOrderChange={onColumnOrderChange}
      onColumnWidthChange={onColumnWidthChange}
      onRenderedItemsChange={onRenderedItemsChange}
      onRowClick={onSelectionRowClick ?? (getRowHref ? openProject : undefined)}
      onRowKeyboardNavigate={onRowKeyboardNavigate}
      onRowRangeDrag={onRowRangeDrag}
      onRowSelectionToggle={onRowSelectionToggle}
      // ISS-13007: header select-all is intentionally absent; this preserves Cmd/Ctrl+A.
      onSelectAllRows={onSelectAllRows}
      onSort={onSort}
      renderCell={(columnId, row) => {
        if (columnId === PROJECT_ROW_ACTIONS_COLUMN_ID) {
          return rowActions?.(row) ?? null;
        }
        return renderProjectCell(columnId, row, cellEditors);
      }}
      renderLead={(row) => (
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <ProjectLead getRowHref={getRowHref} row={row} />
          </div>
        </div>
      )}
      renderNarrowTrailingAction={rowActions}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

/** Captured-main Projects card, retained only behind the closed rollout flag. */
function ProjectCard({
  getRowHref,
  row,
}: {
  getRowHref?: (row: ProjectSummaryRow) => string;
  row: ProjectSummaryRow;
}) {
  const content = (
    <>
      <div className="flex items-center gap-2">
        <ProjectCompletionIcon row={row} />
        <span className="font-mono text-muted-foreground text-xs">
          {row.code ?? "Project"}
        </span>
      </div>
      <div className="mt-2 font-medium text-sm">{row.name}</div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <ProjectOwnerValue row={row} />
        <span className="text-muted-foreground text-xs">
          {priorityLabel(row.priority)}
        </span>
      </div>
    </>
  );
  const className =
    "block rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-muted/30";
  const href = getRowHref?.(row);

  return href ? (
    <Link className={className} href={href}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

/**
 * The completion ring plus its tooltip. `null` is the empty population — no
 * child tasks, or a host that does not hold the count — and the ring renders
 * its own dash for that rather than a 0% arc.
 */
export function ProjectCompletionIcon({ row }: { row: ProjectSummaryRow }) {
  const value = projectCompletionValue(row);
  const label = projectCompletionLabel(row);
  return value === null ? (
    <StatusPercentageIcon label={label} size={16} value={null} />
  ) : (
    <StatusPercentageIcon label={label} size={16} value={value} />
  );
}

function ProjectLead({
  getRowHref,
  row,
}: {
  getRowHref?: (row: ProjectSummaryRow) => string;
  row: ProjectSummaryRow;
}) {
  const content = (
    <>
      <span className="inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {row.code ?? ""}
      </span>
      {/* The ring states its own name (`StatusPercentageIcon` renders the
          `role="img"` + `aria-label`), so this span is the sizing box only —
          repeating the label here announced the same sentence twice. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-6 shrink-0 items-center justify-center">
            <ProjectCompletionIcon row={row} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{projectCompletionLabel(row)}</TooltipContent>
      </Tooltip>
      <span className="min-w-0 truncate font-medium text-sm hover:underline">
        {row.name}
      </span>
    </>
  );
  const href = getRowHref?.(row);

  return href ? (
    <Link
      className="flex min-w-0 items-center gap-2"
      href={href}
      onClick={(event) => event.stopPropagation()}
    >
      {content}
    </Link>
  ) : (
    <div className="flex min-w-0 items-center gap-2">{content}</div>
  );
}

function renderProjectCell(
  columnId: string,
  row: ProjectSummaryRow,
  cellEditors?: ProjectCellEditors
): ReactNode {
  if (columnId === "priority") {
    return cellEditors?.priority ? (
      cellEditors.priority(row)
    ) : (
      <ProjectPriorityValue row={row} />
    );
  }
  if (columnId === "owner") {
    return cellEditors?.owner ? (
      cellEditors.owner(row)
    ) : (
      <ProjectOwnerValue row={row} />
    );
  }
  if (columnId === "dueDate") {
    return cellEditors?.dueDate ? (
      cellEditors.dueDate(row)
    ) : (
      <ProjectDueDateValue row={row} />
    );
  }
  if (columnId === "updated") {
    return (
      <span className="text-muted-foreground text-xs">{row.updatedLabel}</span>
    );
  }
  return null;
}

/** The read-only Priority cell, and the value an editor's trigger wraps. */
export function ProjectPriorityValue({ row }: { row: ProjectSummaryRow }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs">
      <PriorityIcon priority={row.priority ?? ""} />
      {priorityLabel(row.priority)}
    </div>
  );
}

/** The read-only Due Date cell, and the value an editor's trigger wraps. */
export function ProjectDueDateValue({ row }: { row: ProjectSummaryRow }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs">
      <CalendarIcon className="size-4" />
      {row.dueDateLabel ?? "—"}
    </div>
  );
}

/** The read-only Owner cell, and the value an editor's trigger wraps. */
export function ProjectOwnerValue({ row }: { row: ProjectSummaryRow }) {
  return (
    <div className="flex items-center gap-2">
      {row.owner ? (
        <ProjectOwnerAvatar owner={row.owner} />
      ) : (
        <div className="size-5 rounded-full border border-muted-foreground/40 border-dashed" />
      )}
      <span className="truncate text-muted-foreground text-xs">
        {row.owner?.name ?? "No owner"}
      </span>
    </div>
  );
}

/**
 * The owner's photo when the host holds one, one initial otherwise, on the
 * shared avatar colours: an owner's accent no longer tints the avatar (Nerys,
 * 2026-10-22).
 */
export function ProjectOwnerAvatar({ owner }: { owner: ProjectSummaryOwner }) {
  return (
    <Avatar className="size-5">
      <AvatarImage alt={owner.name} src={owner.avatarUrl} />
      <AvatarFallback className="text-[9px]">
        {avatarInitial(owner.initials)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * The no-rows state for the Projects surface, shared by every layout. The board
 * has no rows of its own to hang it off, so it cannot own a copy: a new team on
 * the board would otherwise get a blank grid where the list offers Create.
 */
export function ProjectsEmptyState({
  emptyStateAction,
  emptyStateCopy,
  filtersActive = false,
}: {
  readonly emptyStateAction?: ReactNode;
  readonly emptyStateCopy?: ProjectsEmptyStateCopy;
  readonly filtersActive?: boolean;
}) {
  if (filtersActive) {
    return (
      <EmptyState
        description="Try widening or clearing a filter to see more projects."
        icon={FolderKanbanIcon}
        title="No projects match these filters"
      />
    );
  }
  return (
    <EmptyState
      action={emptyStateAction}
      description={
        emptyStateCopy?.description ??
        "Projects will appear here after they are added to this team."
      }
      icon={FolderKanbanIcon}
      title={emptyStateCopy?.title ?? "No projects yet"}
    />
  );
}

/**
 * Per-column inline editors a host supplies for the three value columns it can
 * write. One render prop per column rather than one keyed by id, so a host
 * cannot supply an editor for a column that cannot be edited and a new editable
 * column has to be named here before a cell can reach it.
 */
export type ProjectCellEditors = {
  readonly dueDate?: (row: ProjectSummaryRow) => ReactNode;
  readonly owner?: (row: ProjectSummaryRow) => ReactNode;
  readonly priority?: (row: ProjectSummaryRow) => ReactNode;
};

export type ProjectsEmptyStateCopy = {
  readonly description: string;
  readonly title: string;
};
