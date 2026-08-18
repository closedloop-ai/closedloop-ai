"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import type { Tone } from "@repo/design-system/components/ui/types";
import {
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  ListFilterIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useState } from "react";
import {
  autonomyShortLabel,
  SESSIONS_DATE_RANGE_LABEL,
  SESSIONS_TOTAL_PAGES,
  type SessionRow,
  SessionStatus,
  sessions,
  TOTAL_SESSIONS,
  TOTAL_TOKENS,
} from "../mock";

// Mirrors the desktop page-shell dashboard grid: two summary cards sit in the
// left half of a four-track grid on wide viewports.
const METRIC_GRID_CLASS_NAME =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4";
const METRIC_CARD_CLASS_NAME = "h-full [&_[data-slot='card-title']]:text-3xl";

const DATE_RANGES = ["7d", "30d", "90d", "All"] as const;

const COLUMNS: readonly GridTableColumn[] = [
  { id: "status", label: "Status", sortable: true },
  { id: "autonomy", label: "Autonomy" },
  { id: "repo", label: "Repository", sortable: true },
  { id: "branch", label: "Branch" },
  { id: "pr", label: "PR" },
];

const GRID_TEMPLATE_COLUMNS =
  "minmax(300px, 1fr) 132px 140px 180px 180px 148px";

const STATUS_CONFIG: Record<
  SessionRow["status"],
  { label: string; tone: Tone; pulse?: boolean }
> = {
  [SessionStatus.Active]: { label: "Active", tone: "success", pulse: true },
  [SessionStatus.Completed]: { label: "Completed", tone: "muted" },
};

const SessionsToolbar = () => {
  const [dateRange, setDateRange] = useState<string>("30d");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        aria-label="Date range"
        onValueChange={(next) => {
          if (next) {
            setDateRange(next);
          }
        }}
        type="single"
        value={dateRange}
        variant="outline"
      >
        {DATE_RANGES.map((range) => (
          <ToggleGroupItem
            className="px-2.5 data-[variant=outline]:h-[26px]"
            key={range}
            value={range}
          >
            {range}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Button size="sm" variant="outline">
        <ListFilterIcon />
        Filter
      </Button>
      <Button size="sm" variant="outline">
        <SlidersHorizontalIcon />
        View
      </Button>
    </div>
  );
};

const renderCell = (columnId: string, row: SessionRow) => {
  switch (columnId) {
    case "status": {
      const config = STATUS_CONFIG[row.status];
      return (
        <ToneBadge
          label={config.label}
          pulse={config.pulse}
          tone={config.tone}
        />
      );
    }
    case "autonomy":
      return row.autonomy === null ? (
        <GridEmptyValue />
      ) : (
        <span className="text-sm">
          {autonomyShortLabel(row.autonomy)}{" "}
          <span className="text-muted-foreground tabular-nums">
            · {row.autonomy}
          </span>
        </span>
      );
    case "repo":
      return row.repo ? (
        <Chip className="min-w-0 gap-1" variant="outline">
          <FolderGit2Icon className="size-3 shrink-0" />
          <span className="truncate">{row.repo}</span>
        </Chip>
      ) : (
        <GridEmptyValue />
      );
    case "branch":
      return row.branch ? (
        <Chip className="min-w-0 gap-1" variant="outline">
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate">{row.branch}</span>
        </Chip>
      ) : (
        <GridEmptyValue />
      );
    case "pr":
      return row.pr ? (
        <Chip className="min-w-0 gap-1" variant="outline">
          <GitPullRequestIcon className="size-3 shrink-0" />
          <span className="truncate">{row.pr}</span>
        </Chip>
      ) : (
        <GridEmptyValue />
      );
    default:
      return null;
  }
};

const renderLead = (row: SessionRow) => (
  <span className="flex min-w-0 items-center gap-2">
    <button
      className="min-w-0 truncate font-medium text-foreground text-sm group-hover:underline"
      type="button"
    >
      {row.name}
    </button>
    {row.awaitingInput ? (
      <ToneBadge
        className="shrink-0"
        label="Awaiting input"
        pulse
        tone="accent"
      />
    ) : null}
  </span>
);

export const SessionsView = () => {
  const [page, setPage] = useState(0);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Filter bar — flush to the top of the content area with a full-width
          bottom border, matching the desktop SessionsView layout. */}
      <div className="shrink-0 border-b px-4 py-3">
        <SessionsToolbar />
      </div>

      {/* Scroll region — cards + table share one bounded scroll container. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 flex flex-col gap-3 px-4 pt-4 pb-3">
          <div className={METRIC_GRID_CLASS_NAME}>
            <MetricCard
              className={METRIC_CARD_CLASS_NAME}
              detail={SESSIONS_DATE_RANGE_LABEL}
              label="Total Sessions"
              value={TOTAL_SESSIONS}
            />
            <MetricCard
              className={METRIC_CARD_CLASS_NAME}
              detail={SESSIONS_DATE_RANGE_LABEL}
              label="Total Tokens"
              value={TOTAL_TOKENS}
            />
          </div>
        </div>

        <GridTable
          columns={COLUMNS}
          getRowId={(row) => row.id}
          gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
          items={[...sessions]}
          leadingLabel="Session Name"
          onSort={() => undefined}
          renderCell={renderCell}
          renderLead={renderLead}
          sortBy={null}
        />
      </div>

      {/* Fixed footer — page controls, always visible. */}
      <div className="shrink-0 overflow-x-auto border-t px-2 py-2">
        <TablePagination
          className="min-w-max"
          onPageChange={setPage}
          page={page}
          totalPages={SESSIONS_TOTAL_PAGES}
        />
      </div>
    </div>
  );
};
