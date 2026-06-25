"use client";

import {
  HarnessBadge,
  SessionStatusBadge,
} from "@repo/app/agents/components/session-status-badges";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { getAutonomyShortLabel } from "../../lib/autonomy";

/**
 * Presentational, data-agnostic sessions table shared across surfaces (web
 * `apps/app`, desktop renderer). Callers map their own session records to
 * `SessionTableRow` (display-ready strings) and supply `renderName` to wrap the
 * session name in their platform's navigation element — a `<Link>` on the web,
 * a `<button onClick={openSession}>` on desktop. The "Autonomy" column renders
 * the session's autonomy score (FEA-2094); rows without a value show an empty
 * placeholder.
 */

export type SessionTableRow = {
  id: string;
  name: string;
  /** Owner/runner of the session. `null` when no identity is available. */
  user?: { name: string; avatarUrl?: string | null } | null;
  status: string;
  harness: string;
  /** Producer-owned display branch for the session, if available. */
  branch?: string | null;
  repo?: string | null;
  model?: string | null;
  durationLabel: string;
  costLabel: string;
  startedLabel: string;
  /** PLN-1034: rendered most-recent-genuine-activity time; the default sort. */
  lastActivityLabel: string;
  /** Autonomy score 0–100 (FEA-2094); `null`/absent when no metric is available. */
  autonomy?: number | null;
};

const EXTRA_COLUMN_ID = "extra";

const LEAD_WIDTH = "minmax(300px, 1fr)";
const EXTRA_COLUMN_GRID_TRACK = "minmax(140px, 0.5fr)";

// Each data column carries its grid width so the columns show/hide menu can drop
// a column AND its track in lockstep. The "Autonomy" column is always shown and
// excluded from the show/hide menu.
const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "status", label: "Status", width: "132px", sortable: true },
  {
    id: "autonomy",
    label: "Autonomy",
    width: "140px",
  },
  { id: "repo", label: "Repository", width: "180px", sortable: true },
  { id: "branch", label: "Branch", width: "180px" },
  { id: "harness", label: "Harness", width: "124px", sortable: true },
  { id: "model", label: "Model", width: "160px", sortable: true },
  { id: "duration", label: "Duration", width: "104px", sortable: true },
  { id: "cost", label: "Cost", width: "100px", sortable: true },
  { id: "started", label: "Started", width: "120px", sortable: true },
  { id: "lastActivity", label: "Last active", width: "120px", sortable: true },
];

export function SessionsTable({
  items,
  renderName,
  extraColumnLabel,
  renderExtraColumn,
  visibleColumns,
  sortBy,
  sortDir,
  onSort,
}: {
  items: SessionTableRow[];
  /**
   * Wrap the session name in the platform's navigation element. `className`
   * carries the name styling; apply it to the returned link/button.
   */
  renderName: (row: SessionTableRow, className: string) => ReactNode;
  /**
   * Optional trailing column (e.g. org-monitoring "Artifact"/"State"). When a
   * label is supplied the grid grows one track and renders `renderExtraColumn`
   * per row; otherwise the table is identical to the base layout.
   */
  extraColumnLabel?: string;
  renderExtraColumn?: (row: SessionTableRow) => ReactNode;
  /** When provided, only these data-column ids render (autonomy always shows). */
  visibleColumns?: Set<string>;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
}) {
  const dataSpecs = visibleColumns
    ? COLUMN_SPECS.filter(
        (spec) => spec.id === "autonomy" || visibleColumns.has(spec.id)
      )
    : COLUMN_SPECS;
  const specs = extraColumnLabel
    ? [
        ...dataSpecs,
        {
          id: EXTRA_COLUMN_ID,
          label: extraColumnLabel,
          width: EXTRA_COLUMN_GRID_TRACK,
        },
      ]
    : dataSpecs;
  const columns: GridTableColumn[] = specs.map(
    ({ width, ...column }) => column
  );
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");
  return (
    <GridTable
      columns={columns}
      getRowId={(row) => row.id}
      gridTemplateColumns={gridTemplateColumns}
      items={items}
      leadingLabel="Session Name"
      onSort={onSort}
      renderCell={(columnId, row) =>
        columnId === EXTRA_COLUMN_ID
          ? (renderExtraColumn?.(row) ?? null)
          : renderSessionCell(columnId, row)
      }
      renderLead={(row) =>
        renderName(row, "truncate font-medium text-sm group-hover:underline")
      }
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function renderSessionCell(columnId: string, row: SessionTableRow): ReactNode {
  switch (columnId) {
    case "status":
      return <SessionStatusBadge status={row.status} />;
    case "autonomy":
      return row.autonomy == null ? (
        <GridEmptyValue />
      ) : (
        <span className="text-sm">
          {getAutonomyShortLabel(row.autonomy)}{" "}
          <span className="text-muted-foreground tabular-nums">
            · {row.autonomy}
          </span>
        </span>
      );
    case "repo":
      return renderRepoChip(row.repo ?? null);
    case "branch":
      return renderBranchChip(row.branch ?? null);
    case "harness":
      return <HarnessBadge harness={row.harness} />;
    case "model":
      return row.model ? (
        <Chip className="min-w-0" variant="outline">
          <span className="truncate">{row.model}</span>
        </Chip>
      ) : (
        <GridEmptyValue />
      );
    case "duration":
      return (
        <span className="font-mono text-muted-foreground text-xs">
          {row.durationLabel}
        </span>
      );
    case "cost":
      return <span className="text-sm tabular-nums">{row.costLabel}</span>;
    case "started":
      return (
        <span className="text-muted-foreground text-xs">
          {row.startedLabel}
        </span>
      );
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {row.lastActivityLabel}
        </span>
      );
    default:
      return null;
  }
}

function renderRepoChip(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return (
    <Chip className="min-w-0 gap-1" variant="outline">
      <FolderGit2Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Chip>
  );
}

function renderBranchChip(label: string | null): ReactNode {
  if (!label) {
    return <GridEmptyValue />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Chip
          className="min-w-0 gap-1"
          interactive
          tabIndex={0}
          variant="outline"
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate font-mono">{label}</span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words font-mono">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
