"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { BlocksIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import {
  adoptionPct,
  catalogPacks,
  type DistributedPack,
  distributedPacks,
  distributionModeMeta,
  formatCount,
  PageState,
} from "../mock";
import { PackListRow } from "./pack-list-row";
import { PageSection } from "./page-section";
import { SourceStatusLine } from "./source-status-line";

const ADMIN_COLUMNS: readonly GridTableColumn[] = [
  { id: "version", label: "Version" },
  { id: "mode", label: "Mode" },
  { id: "adoption", label: "Adoption" },
  {
    id: "usage",
    label: "Usage (30d)",
    tooltip: "Invocations in the last 30 days",
  },
];

// lead + 4 tracks. The lead is the widest (pack name + publisher).
const ADMIN_GRID = "minmax(14rem,2fr) 7rem 12rem 9rem 8rem";

const renderLead = (pack: DistributedPack) => (
  <div className="flex min-w-0 flex-col">
    <span className="truncate font-medium text-sm">{pack.name}</span>
    <span className="truncate text-muted-foreground text-xs">
      {pack.publisher}
    </span>
  </div>
);

const AdoptionCell = ({ pack }: { pack: DistributedPack }) => {
  const pct = adoptionPct(pack);
  // Adoption is one fact — "128 of 132 (97%)" — kept to a single line so the
  // cell fits GridTable's fixed h-11 row. The failure count is the one thing an
  // admin acts on, so it gets its own compact danger line beneath rather than a
  // third stacked line that would overflow the row.
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-sm tabular-nums">
        {formatCount(pack.installed)} of {formatCount(pack.targeted)} ({pct}%)
      </span>
      {pack.failedInstalls ? (
        <span className="flex items-center gap-1.5 text-destructive text-xs tabular-nums">
          <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
          {formatCount(pack.failedInstalls)} failed to install
        </span>
      ) : null}
    </div>
  );
};

const renderCell = (columnId: string, pack: DistributedPack) => {
  if (columnId === "version") {
    return (
      <span className="text-muted-foreground text-sm tabular-nums">
        {pack.version}
      </span>
    );
  }
  if (columnId === "mode") {
    const meta = distributionModeMeta[pack.mode];
    return (
      <SourceStatusLine
        description={meta.gloss}
        icon={meta.icon}
        text={meta.label}
      />
    );
  }
  if (columnId === "adoption") {
    return <AdoptionCell pack={pack} />;
  }
  if (columnId === "usage") {
    return pack.invocations30d === null ? (
      <span className="text-muted-foreground text-sm">Not reported</span>
    ) : (
      <span className="text-sm tabular-nums">
        {formatCount(pack.invocations30d)}
      </span>
    );
  }
  return null;
};

const TableSkeleton = () => (
  <div className="flex flex-col gap-3">
    {[0, 1, 2, 3].map((row) => (
      <div className="flex items-center gap-4" key={row}>
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-20" />
      </div>
    ))}
  </div>
);

const AddPacksAction = () => (
  <Button size="sm" variant="outline">
    <PlusIcon aria-hidden="true" />
    Add packs
  </Button>
);

const DistributedTable = () => (
  <GridTable
    columns={ADMIN_COLUMNS}
    getRowId={(pack) => pack.id}
    gridTemplateColumns={ADMIN_GRID}
    items={[...distributedPacks]}
    leadingLabel="Pack"
    renderCell={renderCell}
    renderLead={renderLead}
  />
);

// The empty treatment lives inside the primary section, not as a page-level
// return, so the secondary "Add packs" catalog it points you to stays on screen.
const DistributedEmpty = () => (
  <EmptyState
    description="Distribute a pack from the catalog below to require or offer it to members."
    icon={BlocksIcon}
    title="You're not distributing any packs yet"
  />
);

const distributedBody = (state: PageState) => {
  if (state === PageState.Loading) {
    return <TableSkeleton />;
  }
  if (state === PageState.Empty) {
    return <DistributedEmpty />;
  }
  return <DistributedTable />;
};

export const AdminView = ({ state }: { readonly state: PageState }) => (
  <div className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
    <PageSection
      description="Packs you require or offer across your org, and how they're being adopted."
      title="Packs you distribute"
    >
      {distributedBody(state)}
    </PageSection>

    <PageSection
      action={<AddPacksAction />}
      description="Browse the marketplace to add a pack to your org's catalog."
      title="Add packs"
    >
      {state === PageState.Loading ? (
        <TableSkeleton />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {catalogPacks.map((pack) => (
            <PackListRow
              action={
                <Button size="sm" variant="outline">
                  Distribute
                </Button>
              }
              key={pack.id}
              pack={pack}
            />
          ))}
        </div>
      )}
    </PageSection>
  </div>
);
