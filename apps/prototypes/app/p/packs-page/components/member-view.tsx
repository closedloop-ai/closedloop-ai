"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { BlocksIcon, LayersIcon, TriangleAlertIcon } from "lucide-react";
import {
  type MemberPack,
  memberAvailable,
  memberInstalled,
  memberRequired,
  PageState,
} from "../mock";
import { InstallSourceLabel } from "./install-source-label";
import { PackListRow } from "./pack-list-row";
import { PageSection } from "./page-section";
import { SourceStatusLine } from "./source-status-line";

const MEMBER_COLUMNS: readonly GridTableColumn[] = [
  { id: "version", label: "Version" },
  { id: "source", label: "Source" },
];

// lead + version + source. Source is wide enough for the labelled chip.
const MEMBER_GRID = "minmax(16rem,1fr) 7rem 16rem";

const MEMBER_GROUP = {
  Required: "required",
  Installed: "installed",
} as const;

const renderLead = (pack: MemberPack) => (
  <div className="flex min-w-0 flex-col">
    <span className="truncate font-medium text-sm">{pack.name}</span>
    <span className="truncate text-muted-foreground text-xs">
      {pack.publisher} · {pack.description}
    </span>
  </div>
);

const SourceCell = ({ pack }: { pack: MemberPack }) => {
  if (pack.installFailed) {
    // The honest strand: required, but the push failed on this machine.
    return (
      <SourceStatusLine
        icon={TriangleAlertIcon}
        text="Required, install failed"
        tone="danger"
      />
    );
  }
  if (pack.source) {
    return <InstallSourceLabel source={pack.source} />;
  }
  return <span className="text-muted-foreground text-sm">Not installed</span>;
};

const renderCell = (columnId: string, pack: MemberPack) => {
  if (columnId === "version") {
    return (
      <span className="text-muted-foreground text-sm tabular-nums">
        {pack.version}
      </span>
    );
  }
  if (columnId === "source") {
    return <SourceCell pack={pack} />;
  }
  return null;
};

const GroupedSkeleton = () => (
  <div className="flex flex-col gap-3">
    {[0, 1, 2, 3, 4].map((row) => (
      <div className="flex items-center gap-4" key={row}>
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-40" />
      </div>
    ))}
  </div>
);

const MEMBER_GROUPS: GridTableGroup<MemberPack>[] = [
  {
    key: MEMBER_GROUP.Required,
    label: "Required by your org",
    items: [...memberRequired],
  },
  {
    key: MEMBER_GROUP.Installed,
    label: "Installed",
    items: [...memberInstalled],
  },
];

const YourPacksTable = () => (
  <GridTable
    columns={MEMBER_COLUMNS}
    getRowId={(pack) => `${pack.id}-${pack.source ?? "none"}`}
    gridTemplateColumns={MEMBER_GRID}
    groupIcon={<LayersIcon aria-hidden="true" />}
    groups={MEMBER_GROUPS}
    items={[]}
    leadingLabel="Pack"
    renderCell={renderCell}
    renderLead={renderLead}
  />
);

// Empty treatment inside the primary section so the "Available" catalog it tells
// you to browse stays rendered, not hidden by a page-level return.
const YourPacksEmpty = () => (
  <EmptyState
    description="Your org hasn't distributed any packs, and you haven't installed any yet. Browse the catalog below to add one."
    icon={BlocksIcon}
    title="No packs yet"
  />
);

const yourPacksBody = (state: PageState) => {
  if (state === PageState.Loading) {
    return <GroupedSkeleton />;
  }
  if (state === PageState.Empty) {
    return <YourPacksEmpty />;
  }
  return <YourPacksTable />;
};

export const MemberView = ({ state }: { readonly state: PageState }) => (
  <div className="mx-auto flex max-w-4xl flex-col gap-10 p-6">
    <PageSection
      description="What your org requires or you've installed, and where each one came from."
      title="Your packs"
    >
      {yourPacksBody(state)}
    </PageSection>

    <PageSection
      description="Packs in your org's catalog you can install yourself."
      title="Available"
    >
      {state === PageState.Loading ? (
        <GroupedSkeleton />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {memberAvailable.map((pack) => (
            <PackListRow
              action={
                <Button size="sm" variant="outline">
                  Install
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
