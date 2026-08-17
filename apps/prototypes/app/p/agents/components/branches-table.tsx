"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import {
  CircleDotIcon,
  ClockIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  HistoryIcon,
  LayersIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { UserPill } from "../component-meta";
import { type Branch, BranchState, branchDisplayName } from "../detail-data";
import type { TableColumn } from "./use-table-controls";

// These state chips render in a <Chip>, whose variant union is narrower than
// the Badge's (it has no "error"), so derive the type from Chip rather than
// reusing BadgeVariant.
type ChipVariant = ComponentProps<typeof Chip>["variant"];

const BRANCH_STATE_META: Record<
  BranchState,
  { label: string; variant: ChipVariant }
> = {
  [BranchState.Merged]: { label: "Merged", variant: "accent" },
  [BranchState.Open]: { label: "Open", variant: "success" },
  [BranchState.Draft]: { label: "Draft", variant: "muted" },
};

type BranchColumnSpec = TableColumn & { width: string; tooltip?: string };

const COLUMN_SPECS: readonly BranchColumnSpec[] = [
  {
    id: "owner",
    label: "Owner",
    width: "168px",
    icon: <UserIcon className="size-4" />,
  },
  {
    id: "version",
    label: "Version",
    width: "116px",
    icon: <HistoryIcon className="size-4" />,
    tooltip:
      "The component version that ran on this branch — not the branch's own version.",
  },
  {
    id: "repo",
    label: "Repository",
    width: "168px",
    icon: <FolderGit2Icon className="size-4" />,
  },
  {
    id: "status",
    label: "Status",
    width: "128px",
    icon: <CircleDotIcon className="size-4" />,
  },
  {
    id: "lastActivity",
    label: "Last active",
    width: "116px",
    icon: <ClockIcon className="size-4" />,
  },
  {
    id: "sessions",
    label: "Linked Sessions",
    width: "132px",
    icon: <LayersIcon className="size-4" />,
  },
  {
    id: "changes",
    label: "Changes",
    width: "140px",
    icon: <GitCompareIcon className="size-4" />,
  },
  {
    id: "pr",
    label: "Pull request",
    width: "150px",
    icon: <GitPullRequestIcon className="size-4" />,
  },
];

// Public column list (id + label + icon) for the View menu.
export const BRANCH_COLUMNS: readonly TableColumn[] = COLUMN_SPECS.map(
  ({ width: _width, ...column }) => column
);

export const branchStatusLabel = (state: BranchState): string =>
  BRANCH_STATE_META[state].label;

const ChangesBar = ({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) => (
  <span className="flex items-center gap-1.5 text-xs tabular-nums">
    <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
    <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>
  </span>
);

const renderCell = (columnId: string, branch: Branch): ReactNode => {
  switch (columnId) {
    case "owner":
      return <UserPill name={branch.owner} />;
    case "version":
      return branch.version ? (
        <span className="text-muted-foreground text-sm tabular-nums">
          {branch.version}
        </span>
      ) : (
        <GridEmptyValue />
      );
    case "repo":
      return (
        <Chip className="min-w-0 gap-1" variant="outline">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{branch.repo}</span>
        </Chip>
      );
    case "status":
      return (
        <Chip variant={BRANCH_STATE_META[branch.state].variant}>
          <span className="size-1.5 rounded-full bg-current" />
          {BRANCH_STATE_META[branch.state].label}
        </Chip>
      );
    case "lastActivity":
      return (
        <span className="text-muted-foreground text-xs">
          {branch.mergedAgo}
        </span>
      );
    case "sessions":
      return (
        <Chip className="gap-1" variant="muted">
          <UsersIcon className="size-3 shrink-0" />
          {branch.sessions}
        </Chip>
      );
    case "changes":
      return (
        <ChangesBar additions={branch.additions} deletions={branch.deletions} />
      );
    default:
      return (
        <Chip className="min-w-0 gap-1" variant="outline">
          <GitPullRequestIcon className="size-3 shrink-0" />
          <span className="truncate">#{branch.prNumber}</span>
        </Chip>
      );
  }
};

const LEAD_WIDTH = "minmax(260px, 1fr)";

// Presentational replica of the branches page's shared BranchesTable, scoped to
// the prototype (the real one lives in @repo/app and is not catalog-importable).
export const BranchesTable = ({
  branches,
  groups,
  hiddenColumns,
  groupIcon,
  onOpenBranch,
}: {
  branches: readonly Branch[];
  groups?: GridTableGroup<Branch>[];
  hiddenColumns?: ReadonlySet<string>;
  groupIcon?: ReactNode;
  onOpenBranch?: (branch: Branch) => void;
}) => {
  const visibleSpecs = COLUMN_SPECS.filter(
    (spec) => !hiddenColumns?.has(spec.id)
  );
  const columns: GridTableColumn[] = visibleSpecs.map(
    ({ width: _width, icon: _icon, ...column }) => column
  );
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...visibleSpecs.map((spec) => spec.width),
  ].join(" ");

  return (
    <GridTable
      columns={columns}
      getRowId={(branch) => branch.id}
      gridTemplateColumns={gridTemplateColumns}
      groupIcon={groupIcon}
      groups={groups}
      items={[...branches]}
      leadingLabel="Branch"
      renderCell={renderCell}
      renderLead={(branch) => (
        <button
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left font-medium text-sm"
          onClick={() => onOpenBranch?.(branch)}
          type="button"
        >
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{branchDisplayName(branch)}</span>
        </button>
      )}
    />
  );
};
