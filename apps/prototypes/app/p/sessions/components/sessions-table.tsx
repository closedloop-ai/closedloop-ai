"use client";

import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { ReactNode } from "react";
import { formatAgo, formatDuration, type SessionRow } from "../mock";
import {
  AutonomyCell,
  HarnessChip,
  ModelCell,
  OwnerCell,
  RepoChip,
  SessionStatusChip,
} from "./session-cells";
import {
  CollaboratorsCell,
  LinkedAgentsCell,
  LinkedBranchesCell,
  LinkedIssuesCell,
  ProjectsCell,
  TagsCell,
  UpdatedCell,
} from "./session-columns";
import { SessionLeadCell } from "./session-lead-cell";

const LEAD_WIDTH = "minmax(400px, 1.4fr)";

// Each data column carries its grid width so the View menu can drop a column and
// its track in lockstep — mirrors the in-product SessionsTable COLUMN_SPECS.
const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "status", label: "Status", width: "132px", sortable: true },
  { id: "tags", label: "Tags", width: "180px" },
  { id: "owner", label: "Owner", width: "170px" },
  { id: "collaborators", label: "Collaborators", width: "128px" },
  { id: "autonomy", label: "Autonomy", width: "116px" },
  { id: "projects", label: "Projects", width: "180px" },
  { id: "repo", label: "Repository", width: "170px", sortable: true },
  { id: "branches", label: "Linked branches", width: "300px" },
  { id: "issues", label: "Linked issues", width: "150px" },
  { id: "agents", label: "Linked agents", width: "200px" },
  { id: "harness", label: "Harness", width: "116px", sortable: true },
  { id: "model", label: "Model", width: "160px", sortable: true },
  { id: "duration", label: "Duration", width: "104px", sortable: true },
  { id: "cost", label: "Cost", width: "96px", sortable: true },
  { id: "started", label: "Started", width: "128px", sortable: true },
  { id: "updated", label: "Updated", width: "120px", sortable: true },
  { id: "lastActivity", label: "Last active", width: "120px", sortable: true },
];

export function SessionsTable({
  items,
  groups,
  groupIcon,
  groupedColumnId,
  visibleColumns,
  onOpenDetail,
  sortBy,
  sortDir,
  onSort,
}: {
  items: SessionRow[];
  groups?: GridTableGroup<SessionRow>[];
  groupIcon?: ReactNode;
  /** When grouping is active, the column banded on is hidden to avoid printing
   *  the value twice (group header + row cell). */
  groupedColumnId?: string;
  visibleColumns: Set<string>;
  onOpenDetail: (item: SessionRow) => void;
  sortBy: string;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
}) {
  const specs = COLUMN_SPECS.filter(
    (spec) => visibleColumns.has(spec.id) && spec.id !== groupedColumnId
  );
  const columns: GridTableColumn[] = specs.map(
    ({ width, ...column }) => column
  );
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");

  const renderLead = (item: SessionRow) => (
    <SessionLeadCell item={item} onOpenDetail={onOpenDetail} />
  );

  return (
    <GridTable
      columns={columns}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      groupIcon={groupIcon}
      groups={groups}
      items={items}
      leadingLabel="Session"
      leadingSortKey="name"
      onSort={onSort}
      renderCell={renderSessionCell}
      renderLead={renderLead}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function renderSessionCell(columnId: string, item: SessionRow): ReactNode {
  switch (columnId) {
    case "status":
      return <SessionStatusChip status={item.status} />;
    case "tags":
      return <TagsCell tags={item.tags} />;
    case "owner":
      return <OwnerCell user={item.user} />;
    case "collaborators":
      return <CollaboratorsCell collaborators={item.collaborators} />;
    case "autonomy":
      return <AutonomyCell autonomy={item.autonomy} />;
    case "projects":
      return <ProjectsCell projects={item.projects} />;
    case "repo":
      return <RepoChip repo={item.repo} />;
    case "branches":
      return <LinkedBranchesCell item={item} />;
    case "issues":
      return <LinkedIssuesCell issues={item.linkedIssues} />;
    case "agents":
      return <LinkedAgentsCell agents={item.linkedAgents} />;
    case "harness":
      return <HarnessChip harness={item.harness} />;
    case "model":
      return <ModelCell model={item.model} />;
    case "duration":
      return (
        <span className="text-muted-foreground text-sm tabular-nums">
          {formatDuration(item.durationMs)}
        </span>
      );
    case "cost":
      return (
        <span className="text-sm tabular-nums">${item.cost.toFixed(2)}</span>
      );
    case "started":
      return (
        <span className="text-muted-foreground text-xs">
          {formatAgo(item.startedAgoMinutes)}
        </span>
      );
    case "updated":
      return <UpdatedCell minutes={item.updatedAgoMinutes} />;
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {formatAgo(item.lastActivityAgoMinutes)}
        </span>
      );
    default:
      return <GridEmptyValue />;
  }
}
