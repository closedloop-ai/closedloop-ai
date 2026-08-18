"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { BranchDataState, type BranchRow, shortRepoName } from "../mock";
import {
  BranchChangesBar,
  BranchPRBadge,
  BranchStatusChip,
} from "./branch-cells";

/** A branch whose data is still settling shows a loading indicator. */
function isAwaitingSync(item: BranchRow): boolean {
  return item.dataState === BranchDataState.AwaitingSync;
}

const LEAD_WIDTH = "minmax(320px, 1fr)";

const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "owner", label: "Owner", width: "180px", sortable: true },
  { id: "collaborators", label: "Collaborators", width: "140px" },
  { id: "sessions", label: "Linked sessions", width: "140px", sortable: true },
  { id: "changes", label: "Changes", width: "130px", sortable: true },
  { id: "status", label: "Status", width: "150px", sortable: true },
  { id: "pullRequest", label: "Pull request", width: "140px", sortable: true },
  {
    id: "lastActivity",
    label: "Last active",
    width: "130px",
    sortable: true,
  },
  { id: "repo", label: "Repository", width: "180px", sortable: true },
  { id: "tags", label: "Tags", width: "180px" },
];

export function BranchesTable({
  items,
  visibleColumns,
  onOpenDetail,
  sortBy,
  sortDir,
  onSort,
}: {
  items: BranchRow[];
  visibleColumns: Set<string>;
  onOpenDetail: (item: BranchRow) => void;
  sortBy: string;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
}) {
  const dataSpecs = COLUMN_SPECS.filter((spec) => visibleColumns.has(spec.id));
  const specs = dataSpecs;
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
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      items={items}
      leadingLabel="Name"
      leadingSortKey="name"
      onSort={onSort}
      renderCell={(columnId, item) => renderBranchCell(columnId, item)}
      renderLead={(item) => (
        <button
          className="min-w-0 text-left hover:underline"
          onClick={() => onOpenDetail(item)}
          type="button"
        >
          {renderBranchLead(item)}
        </button>
      )}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function renderBranchLead(item: BranchRow): ReactNode {
  const awaitingSync = isAwaitingSync(item);
  return (
    <span className="flex min-w-0 items-center gap-2 font-medium text-sm">
      {awaitingSync ? (
        <>
          <Loader2Icon
            aria-hidden
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          />
          <span className="sr-only">Syncing branch data. </span>
        </>
      ) : (
        <GitBranchIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate">{item.branchName}</span>
    </span>
  );
}

function renderBranchCell(columnId: string, item: BranchRow): ReactNode {
  switch (columnId) {
    case "owner":
      return <PersonCell name={item.owner} />;
    case "collaborators":
      return <CollaboratorsCell names={item.collaborators} />;
    case "sessions":
      return item.sessionCount > 0 ? (
        <Chip className="gap-1" size="sm" variant="muted">
          <UsersIcon aria-hidden className="size-3 shrink-0" />
          {item.sessionCount}
        </Chip>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "status":
      return <BranchStatusChip status={item.status} />;
    case "pullRequest":
      return <BranchPRBadge item={item} />;
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {item.lastActivityLabel}
        </span>
      );
    case "tags":
      return <LabelList labels={item.tags} />;
    case "changes":
      return (
        <BranchChangesBar
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "repo":
      return (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <FolderGit2Icon className="size-3.5 shrink-0" />
          <span className="truncate">{shortRepoName(item.repo)}</span>
        </span>
      );
    default:
      return null;
  }
}

function PersonCell({ name }: { name: string | null }) {
  if (!name) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <PersonAvatar name={name} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function CollaboratorsCell({ names }: { names: string[] }) {
  if (names.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = names.slice(0, 3);
  return (
    <span className="flex items-center -space-x-1.5">
      {visible.map((name) => (
        <PersonAvatar
          className="ring-2 ring-background"
          key={name}
          name={name}
        />
      ))}
      {names.length > visible.length ? (
        <span className="z-10 ml-2 text-muted-foreground text-xs">
          +{names.length - visible.length}
        </span>
      ) : null}
    </span>
  );
}

function PersonAvatar({
  className,
  name,
}: {
  className?: string;
  name: string;
}) {
  return (
    <Avatar className={`size-6 ${className ?? ""}`}>
      <AvatarFallback className="bg-primary/15 font-medium text-[10px] text-primary">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function LabelList({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = labels.slice(0, 2);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {visible.map((label, index) => (
        <Chip
          className="min-w-0"
          key={label}
          size="sm"
          variant={index === 0 ? "info" : "warning"}
        >
          <span className="truncate">{label}</span>
        </Chip>
      ))}
      {labels.length > visible.length ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          +{labels.length - visible.length}
        </span>
      ) : null}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}
