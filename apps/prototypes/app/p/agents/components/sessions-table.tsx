"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import {
  CircleDollarSignIcon,
  CircleDotIcon,
  ClockIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HistoryIcon,
  UserIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { UserPill } from "../component-meta";
import { sessionRowMeta } from "../detail-data";
import { type MockSession, SessionState } from "../mock";
import type { TableColumn } from "./use-table-controls";

type ChipVariant = ComponentProps<typeof Chip>["variant"];

const SESSION_STATE_META: Record<
  SessionState,
  { label: string; variant: ChipVariant }
> = {
  [SessionState.Active]: { label: "Active", variant: "info" },
  [SessionState.Waiting]: { label: "Waiting", variant: "warning" },
  [SessionState.Completed]: { label: "Completed", variant: "success" },
  [SessionState.Failed]: { label: "Failed", variant: "destructive" },
  [SessionState.Abandoned]: { label: "Abandoned", variant: "muted" },
};

type SessionColumnSpec = TableColumn & { width: string; tooltip?: string };

// ISS-4788: Cost sits ahead of Repository here, matching the production table
// (`packages/app/agents/components/sessions/sessions-table.tsx`). The original
// mock ordered it seventh, which put its track ~1220px from the table's left
// edge — past the fold on a default 1380px desktop window, so the row's headline
// number rendered clipped ("$772.3"). Repository / Branch / PR are truncated
// chips that tolerate living past the fold; a currency figure does not. Keep the
// two in step: this file is the reference the production table reconciles
// against (FEA-4006), so reverting the order here would quietly reintroduce the
// bug on the next reconciliation.
const COLUMN_SPECS: readonly SessionColumnSpec[] = [
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
      "The component version that ran in this session — not the session's own version.",
  },
  {
    id: "status",
    label: "Status",
    width: "140px",
    icon: <CircleDotIcon className="size-4" />,
  },
  {
    id: "cost",
    label: "Cost",
    width: "100px",
    icon: <CircleDollarSignIcon className="size-4" />,
  },
  {
    id: "repo",
    label: "Repository",
    width: "176px",
    icon: <FolderGit2Icon className="size-4" />,
  },
  {
    id: "branch",
    label: "Branch",
    width: "196px",
    icon: <GitBranchIcon className="size-4" />,
  },
  {
    id: "pr",
    label: "PR",
    width: "132px",
    icon: <GitPullRequestIcon className="size-4" />,
  },
  {
    id: "started",
    label: "Started",
    width: "128px",
    icon: <ClockIcon className="size-4" />,
  },
];

// Public column list (id + label + icon) for the View menu.
export const SESSION_COLUMNS: readonly TableColumn[] = COLUMN_SPECS.map(
  ({ width: _width, ...column }) => column
);

export const sessionStatusLabel = (state: SessionState): string =>
  SESSION_STATE_META[state].label;

const renderCell = (columnId: string, session: MockSession): ReactNode => {
  const meta = sessionRowMeta(session);
  switch (columnId) {
    case "owner":
      return <UserPill name={session.user} />;
    case "version":
      return session.version ? (
        <span className="text-muted-foreground text-sm tabular-nums">
          {session.version}
        </span>
      ) : (
        <GridEmptyValue />
      );
    case "status":
      return (
        <Badge variant={SESSION_STATE_META[session.state].variant}>
          {SESSION_STATE_META[session.state].label}
        </Badge>
      );
    case "repo":
      return (
        <Chip className="min-w-0 gap-1" variant="outline">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{meta.repo}</span>
        </Chip>
      );
    case "branch":
      return (
        <Chip className="min-w-0 gap-1" variant="outline">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{meta.branch}</span>
        </Chip>
      );
    case "pr":
      return (
        <Chip className="min-w-0 gap-1" variant="outline">
          {meta.prMerged ? (
            <GitMergeIcon className="size-3 shrink-0" />
          ) : (
            <GitPullRequestIcon className="size-3 shrink-0" />
          )}
          <span className="truncate">#{meta.prNumber}</span>
        </Chip>
      );
    case "cost":
      return <span className="text-sm tabular-nums">{session.cost}</span>;
    default:
      return (
        <span className="text-muted-foreground text-xs">
          {session.startedAgo}
        </span>
      );
  }
};

const LEAD_WIDTH = "minmax(280px, 1fr)";

// Presentational replica of the sessions page's shared SessionsTable, scoped to
// the prototype (the real one lives in @repo/app and is not catalog-importable).
export const SessionsTable = ({
  sessions,
  groups,
  hiddenColumns,
  groupIcon,
  onOpenSession,
}: {
  sessions: readonly MockSession[];
  groups?: GridTableGroup<MockSession>[];
  hiddenColumns?: ReadonlySet<string>;
  groupIcon?: ReactNode;
  onOpenSession?: (session: MockSession) => void;
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
      getRowId={(session) => session.id}
      gridTemplateColumns={gridTemplateColumns}
      groupIcon={groupIcon}
      groups={groups}
      items={[...sessions]}
      leadingLabel="Session Name"
      renderCell={renderCell}
      renderLead={(session) => (
        <button
          className="cursor-pointer truncate text-left font-medium text-sm"
          onClick={() => onOpenSession?.(session)}
          type="button"
        >
          {session.name}
        </button>
      )}
    />
  );
};
