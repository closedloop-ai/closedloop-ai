"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { GitBranchIcon } from "lucide-react";
import { type BranchRow, branchRows, branchSummary } from "../app-mock";

const COLUMNS: readonly GridTableColumn[] = [
  { id: "pr", label: "PR" },
  { id: "status", label: "Status" },
  { id: "repo", label: "Repo" },
  { id: "size", label: "Size" },
  { id: "when", label: "When" },
];

const GRID_TEMPLATE =
  "minmax(220px,1.6fr) 110px 120px minmax(110px,0.8fr) 130px 110px";

const renderCell = (columnId: string, row: BranchRow) => {
  switch (columnId) {
    case "pr":
      return (
        <span className="truncate font-mono text-muted-foreground text-xs">
          {row.pr}
        </span>
      );
    case "status":
      return <ToneBadge label={row.statusLabel} tone={row.statusTone} />;
    case "repo":
      return (
        <span className="truncate font-mono text-muted-foreground text-xs">
          {row.repo}
        </span>
      );
    case "size":
      return <span className="font-mono text-xs">{row.size}</span>;
    case "when":
      return <span className="text-muted-foreground text-sm">{row.when}</span>;
    default:
      return null;
  }
};

const Toolbar = () => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-5 py-3">
    <div className="text-muted-foreground text-sm">Last 90 days</div>
    <Badge variant="outline">Local</Badge>
  </div>
);

export const BranchesView = ({ empty = false }: { empty?: boolean }) => {
  // Zero state (r3706838798): copy mirrors the production Branches empty state.
  if (empty) {
    return (
      <div className="mx-auto w-full max-w-6xl p-5">
        <EmptyState
          className="min-h-[360px] rounded-xl border border-border/70 bg-card"
          description="Branches appear here once they're synced from your connected provider."
          icon={GitBranchIcon}
          title="No branches yet"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Toolbar />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {branchSummary.map((stat) => (
            <MetricCard
              delta={stat.delta}
              deltaLabel={stat.detail}
              deltaPolarity={stat.deltaPolarity}
              info={stat.info}
              key={stat.key}
              label={stat.label}
              value={stat.value}
            />
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">All branches</CardTitle>
          </CardHeader>
          <CardContent>
            <GridTable
              columns={COLUMNS}
              getRowId={(row) => row.id}
              gridTemplateColumns={GRID_TEMPLATE}
              items={[...branchRows]}
              leadingLabel="Branch"
              renderCell={renderCell}
              renderLead={(row) => (
                <span className="truncate font-mono text-primary text-xs">
                  {row.branch}
                </span>
              )}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
