"use client";

import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { TagEntityType } from "@repo/api/src/types/tag";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import { TagChips } from "@repo/app/tags/components/tag-chip";
import { TagPicker } from "@repo/app/tags/components/tag-picker";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
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
import { Link } from "@repo/navigation/link";
import {
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { repositoryDisplayLabels } from "../lib/branch-filter-adapter";
import {
  type BranchRow,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../lib/branch-row";
import { BranchChangesBar } from "./branch-changes-bar";
import { BranchPRBadge } from "./branch-pr-badge";
import { renderBranchStatus } from "./branch-status";

const LEAD_WIDTH = "minmax(300px, 1fr)";
const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "owner", label: "Owner", width: "180px", sortable: true },
  { id: "collaborators", label: "Collaborators", width: "150px" },
  { id: "sessions", label: "Linked sessions", width: "140px", sortable: true },
  { id: "changes", label: "Changes", width: "140px", sortable: true },
  { id: "status", label: "Status", width: "145px", sortable: true },
  { id: "pr", label: "Pull request", width: "150px", sortable: true },
  { id: "lastActivity", label: "Last active", width: "130px", sortable: true },
  { id: "repo", label: "Repository", width: "190px", sortable: true },
  { id: "tags", label: "Tags", width: "210px" },
];

type BranchLeadRenderInput = {
  item: BranchRow;
  className: string;
  children: ReactNode;
};

/** Fixed, horizontally scrollable PRD-601 table with visibility-only columns. */
export function ApprovedBranchesTable({
  items,
  allRows = items,
  visibleColumns,
  getBranchHref,
  renderBranchLink,
  getSessionsHref,
  sortBy,
  sortDir,
  onSort,
  tagsReadOnly = false,
}: {
  items: BranchRow[];
  allRows?: BranchRow[];
  visibleColumns?: Set<string>;
  getBranchHref?: (item: BranchRow) => string;
  renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode;
  getSessionsHref?: (item: BranchRow) => string;
  sortBy?: string | null;
  sortDir?: SortDirection;
  onSort?: (column: string, direction: SortDirection) => void;
  tagsReadOnly?: boolean;
}) {
  const specs = visibleColumns
    ? COLUMN_SPECS.filter((spec) => visibleColumns.has(spec.id))
    : COLUMN_SPECS;
  const labels = repositoryDisplayLabels(allRows);
  return (
    <GridTable
      columns={specs.map(({ width: _width, ...column }) => column)}
      getRowId={(item) => item.id}
      gridTemplateColumns={[
        LEAD_WIDTH,
        ...specs.map((spec) => spec.width),
      ].join(" ")}
      items={items}
      leadingLabel="Name"
      leadingSortKey="name"
      mode="expanded"
      onSort={onSort}
      renderCell={(columnId, item) =>
        renderCell(columnId, item, labels, getSessionsHref, tagsReadOnly)
      }
      renderLead={(item) => renderLead(item, getBranchHref, renderBranchLink)}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function renderLead(
  item: BranchRow,
  getBranchHref?: (item: BranchRow) => string,
  renderBranchLink?: (input: BranchLeadRenderInput) => ReactNode
): ReactNode {
  const awaitingSync = item.dataState === BranchDataState.AwaitingSync;
  const content = (
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
      <span className="truncate font-mono">{item.branchName}</span>
    </span>
  );
  if (renderBranchLink) {
    return renderBranchLink({
      item,
      className: "min-w-0 hover:underline",
      children: content,
    });
  }
  return getBranchHref ? (
    <Link className="min-w-0 hover:underline" href={getBranchHref(item)}>
      {content}
    </Link>
  ) : (
    content
  );
}

function renderCell(
  columnId: string,
  item: BranchRow,
  repositoryLabels: ReadonlyMap<string, string>,
  getSessionsHref: ((item: BranchRow) => string) | undefined,
  tagsReadOnly: boolean
): ReactNode {
  switch (columnId) {
    case "owner":
      return item.owner === RENDER_UNATTRIBUTED ? (
        <span className="text-muted-foreground text-xs">Unattributed</span>
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <PersonAvatar name={item.owner} />
          <span className="truncate">{item.owner}</span>
        </span>
      );
    case "collaborators":
      return <Collaborators people={item.collaborators ?? []} />;
    case "sessions":
      return renderSessions(item, getSessionsHref);
    case "changes":
      return item.additions === null || item.deletions === null ? (
        <span className="text-muted-foreground text-xs">Unavailable</span>
      ) : (
        <BranchChangesBar
          additions={item.additions}
          deletions={item.deletions}
        />
      );
    case "status":
      return renderBranchStatus(item.status);
    case "pr":
      return (
        <BranchPRBadge
          prNumber={item.prNumber}
          prState={item.prState}
          prTitle={item.prTitle}
          prUrl={item.prUrl}
          repoShortName={item.prRepo ?? null}
        />
      );
    case "lastActivity":
      return item.lastActivityAt ? (
        <span className="text-muted-foreground text-xs">
          {item.lastActivityLabel}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">Unavailable</span>
      );
    case "repo":
      return item.repo === RENDER_MISSING ? (
        <span className="text-muted-foreground text-xs">Unavailable</span>
      ) : (
        <RepositoryLink
          displayName={repositoryLabels.get(item.repo) ?? item.repo}
          repositoryFullName={item.repo}
        />
      );
    case "tags":
      return <BranchTags item={item} readOnly={tagsReadOnly} />;
    default:
      return null;
  }
}

function renderSessions(
  item: BranchRow,
  getSessionsHref?: (item: BranchRow) => string
): ReactNode {
  if (item.sessionCount === 0) {
    return <GridEmptyValue />;
  }
  const content = (
    <Chip className="gap-1" size="sm" variant="muted">
      <UsersIcon aria-hidden className="size-3 shrink-0" />
      {item.sessionCount}
    </Chip>
  );
  return getSessionsHref ? (
    <Chip asChild className="gap-1" size="sm" variant="muted">
      <Link
        aria-label={`${item.sessionCount} linked session${
          item.sessionCount === 1 ? "" : "s"
        } for ${item.branchName}`}
        href={getSessionsHref(item)}
      >
        <UsersIcon aria-hidden className="size-3 shrink-0" />
        {item.sessionCount}
      </Link>
    </Chip>
  ) : (
    content
  );
}

function Collaborators({
  people,
}: {
  people: NonNullable<BranchRow["collaborators"]>;
}) {
  if (people.length === 0) {
    return <GridEmptyValue />;
  }
  const visible = people.slice(0, 3);
  return (
    <span
      aria-label={people.map((person) => person.name).join(", ")}
      className="flex items-center -space-x-1.5"
      role="img"
    >
      {visible.map((person) => (
        <PersonAvatar
          avatarUrl={person.avatarUrl}
          className="ring-2 ring-background"
          key={person.key}
          name={person.name}
        />
      ))}
      {people.length > visible.length ? (
        <span
          aria-hidden
          className="z-10 flex size-6 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground ring-2 ring-background"
        >
          +{people.length - visible.length}
        </span>
      ) : null}
    </span>
  );
}

function PersonAvatar({
  avatarUrl,
  className,
  name,
}: {
  avatarUrl?: string;
  className?: string;
  name: string;
}) {
  return (
    <Avatar className={`size-6 ${className ?? ""}`}>
      {avatarUrl ? <AvatarImage alt="" src={avatarUrl} /> : null}
      <AvatarFallback className="bg-primary/15 font-medium text-[10px] text-primary">
        {getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function BranchTags({
  item,
  readOnly,
}: {
  item: BranchRow;
  readOnly: boolean;
}) {
  if (item.tagAvailability === BranchTagAvailability.Unavailable) {
    return <span className="text-muted-foreground text-xs">Unavailable</span>;
  }
  const canApply = Boolean(!readOnly && item.tagPermissions?.canApply);
  const canRemove = Boolean(!readOnly && item.tagPermissions?.canRemove);
  const canMutate = Boolean(item.artifactId && (canApply || canRemove));
  if (!(canMutate && item.artifactId)) {
    return (item.tags ?? []).length > 0 ? (
      <TagChips maxVisible={2} tags={item.tags ?? []} />
    ) : (
      <GridEmptyValue />
    );
  }
  return (
    <TagPicker
      appliedTags={item.tags ?? []}
      canApply={canApply}
      canRemove={canRemove}
      entityId={item.artifactId}
      entityType={TagEntityType.Artifact}
      showAppliedChips={false}
      showCreate={canApply}
      trigger={
        <button
          aria-label={`Edit tags for ${item.branchName}`}
          className="flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          <TagChips maxVisible={2} tags={item.tags ?? []} />
          {canApply ? (
            <PlusIcon aria-hidden className="size-3.5 text-muted-foreground" />
          ) : null}
        </button>
      }
    />
  );
}

/** Linked compact repository label with full identity on focus and hover. */
function RepositoryLink({
  displayName,
  repositoryFullName,
}: {
  displayName: string;
  repositoryFullName: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          aria-label={`${repositoryFullName} repository on GitHub`}
          className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground hover:underline"
          href={repositoryUrl(repositoryFullName)}
          rel="noreferrer"
          target="_blank"
          title={repositoryFullName}
        >
          <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
          <span aria-hidden className="truncate">
            {displayName}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent>{repositoryFullName}</TooltipContent>
    </Tooltip>
  );
}

function repositoryUrl(repositoryFullName: string): string {
  return `https://github.com/${repositoryFullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}
