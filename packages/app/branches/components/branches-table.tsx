"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  FolderGit2Icon,
  GitBranchIcon,
  MessageSquareIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  RENDER_MISSING,
  shortRepoName,
} from "../lib/branch-sample-data";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";
import { BranchRowActionsMenu } from "./branch-row-actions-menu";

/**
 * Branches table — shared by the web `/branches` page and the desktop Branches
 * view, rendered through the design system's generic `GridTable`. The in-scope
 * column set: Name (lead), Repository, Status, Updated, Linked Sessions,
 * Changes, and Pull request. GitHub-live cells degrade to the empty-value
 * affordance when enrichment is absent — never a fabricated value.
 */

const LEAD_WIDTH = "minmax(260px, 1fr)";

// Each data column carries its grid width so the columns show/hide menu (B5a)
// can drop a column AND its track in lockstep.
const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "repo", label: "Repository", width: "160px", sortable: true },
  { id: "status", label: "Status", width: "140px", sortable: true },
  { id: "lastActivity", label: "Last active", width: "110px", sortable: true },
  { id: "sessions", label: "Linked Sessions", width: "130px", sortable: true },
  { id: "changes", label: "Changes", width: "130px", sortable: true },
  { id: "pr", label: "Pull request", width: "150px" },
];

// Always-rendered row-actions column (B5c) — not toggleable, so it's appended
// after the visible data columns rather than living in COLUMN_SPECS.
const ACTIONS_SPEC: GridTableColumn & { width: string } = {
  id: "actions",
  label: "",
  width: "52px",
};

type BranchRowActions = {
  onOpenDetail?: (item: BranchRow) => void;
  onViewSessions?: (item: BranchRow) => void;
};

export function BranchesTable({
  items,
  visibleColumns,
  getBranchHref,
  onOpenDetail,
  onViewSessions,
  sortBy,
  sortDir,
  onSort,
}: {
  items: BranchRow[];
  /** When provided, only these data-column ids render (B5a columns show/hide). */
  visibleColumns?: Set<string>;
  /**
   * Additive (Epic C2): when provided, the Name lead is wrapped in an anchor to
   * the branch detail route. Absent → a plain (non-link) lead, so the list works
   * before Branch Detail (Epic C) lands.
   */
  getBranchHref?: (item: BranchRow) => string;
  /** Row-actions menu (B5c): Open-detail hidden unless provided (Epic C1 gate). */
  onOpenDetail?: (item: BranchRow) => void;
  onViewSessions?: (item: BranchRow) => void;
  /** Column-header sorting — wire all three to enable clickable sort headers. */
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
}) {
  const dataSpecs = visibleColumns
    ? COLUMN_SPECS.filter((spec) => visibleColumns.has(spec.id))
    : COLUMN_SPECS;
  const specs = [...dataSpecs, ACTIONS_SPEC];
  const columns: GridTableColumn[] = specs.map(
    ({ width, ...column }) => column
  );
  // The actions column is the table's final column. GridTable adds no trailing
  // border cell, so the template is just the lead + each column's track (the
  // right edge is open).
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");

  return (
    <GridTable
      columns={columns}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      items={items}
      leadingLabel="Branch"
      leadingSortKey="name"
      onSort={onSort}
      renderCell={(columnId, item) =>
        renderBranchCell(columnId, item, { onOpenDetail, onViewSessions })
      }
      renderLead={(item) => renderBranchLead(item, getBranchHref)}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function renderBranchLead(
  item: BranchRow,
  getBranchHref?: (item: BranchRow) => string
): ReactNode {
  const lead = (
    <span className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono">{item.branchName}</span>
      {/* Comment count is a soft Epic F3 consumer — null until that lands. */}
      {item.commentCount != null && item.commentCount > 0 ? (
        <Chip className="gap-1" variant="muted">
          <MessageSquareIcon className="size-3" />
          {item.commentCount}
        </Chip>
      ) : null}
    </span>
  );

  if (getBranchHref) {
    return (
      <a className="min-w-0 hover:underline" href={getBranchHref(item)}>
        {lead}
      </a>
    );
  }
  return lead;
}

function renderBranchCell(
  columnId: string,
  item: BranchRow,
  actions: BranchRowActions
): ReactNode {
  switch (columnId) {
    case "repo":
      // github-live: no repo identity → missing-data, not a "—" chip.
      return item.repo === RENDER_MISSING ? (
        <GridEmptyValue />
      ) : (
        <Chip className="min-w-0 gap-1" variant="outline">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{shortRepoName(item.repo)}</span>
        </Chip>
      );
    case "status": {
      const config = BRANCH_STATUS_CONFIG[item.status];
      return (
        <Chip variant={config.variant}>
          <span className="size-1.5 rounded-full bg-current" />
          {config.label}
        </Chip>
      );
    }
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {item.lastActivityLabel}
        </span>
      );
    case "sessions":
      return item.sessionCount > 0 ? (
        <Chip className="gap-1" variant="muted">
          <UsersIcon className="size-3 shrink-0" />
          {item.sessionCount}
        </Chip>
      ) : (
        <GridEmptyValue />
      );
    case "changes":
      return (
        <BranchChangesBar
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "pr":
      return (
        <BranchPRBadge
          prNumber={item.prNumber}
          prState={item.prState}
          prTitle={item.prTitle}
          prUrl={item.prUrl}
          repoShortName={
            item.repo === RENDER_MISSING ? null : shortRepoName(item.repo)
          }
        />
      );
    case "actions":
      return (
        <BranchRowActionsMenu
          item={item}
          onOpenDetail={actions.onOpenDetail}
          onViewSessions={actions.onViewSessions}
        />
      );
    default:
      return null;
  }
}
