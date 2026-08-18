"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  buildGridTableCardFields,
  GridTable,
  GridTableCard,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { Progress } from "@repo/design-system/components/ui/progress";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { BlocksIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  adoptionPercent,
  compareDistributedPackRows,
  type DistributedPackRow,
  DistributedPackSortKey,
  type PackAdoption,
} from "../lib/distributed-pack-row";
import { distributionModeMeta } from "../lib/distribution-mode-meta";
import { PageSection } from "./page-section";
import { SourceStatusLine } from "./source-status-line";

// FEA-4088 — the admin manage-first treatment. Primary region: a "Packs you
// distribute" table, one row per active distribution, that answers the admin's
// real job — what am I pushing, which version, how it's being adopted, is it
// being used. Secondary region: the marketplace / add-packs path, demoted so
// discovery no longer outranks management. The marketplace + its create /
// upload / distribute / archive dialogs live in the web app (they need the web
// data hooks + dialogs), so they arrive through `marketplaceSlot` rather than
// being reimplemented here.

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

// Column ids double as the sort keys.
const ADMIN_COLUMNS: readonly GridTableColumn[] = [
  { id: DistributedPackSortKey.Version, label: "Version", sortable: true },
  { id: DistributedPackSortKey.Mode, label: "Mode", sortable: true },
  { id: DistributedPackSortKey.Adoption, label: "Adoption", sortable: true },
  {
    id: DistributedPackSortKey.Usage,
    label: "Usage (30d)",
    sortable: true,
    tooltip: "Invocations in the last 30 days",
  },
];

// Lead (pack name + publisher) + 4 tracks. The lead is the widest.
const ADMIN_GRID = "minmax(14rem,2fr) 6rem 10rem 12rem 8rem";

// The card fallback promotes the pack name into its header, so the name column
// is excluded from the key/value body (it isn't a real table column anyway —
// it's the lead cell).
const CARD_EXCLUDED_COLUMNS = new Set<string>();

const renderLead = (row: DistributedPackRow) => (
  <div className="flex min-w-0 flex-col">
    <span className="truncate font-medium text-sm">{row.name}</span>
    <span className="truncate text-muted-foreground text-xs">
      {row.publisher}
    </span>
  </div>
);

// Adoption reads as a progress bar + percent on a single line (Option A: the
// cell stays within GridTable's fixed row height), with the exact
// installed/target fraction as the bar's accessible name and tooltip so the
// number is honest and screen-reader legible. When adoption hasn't been
// computed for a row (the list read carries no per-target counts — PLN-1497
// OQ4) the cell says "Not available", never a fabricated 0%.
// Radix's default TooltipTrigger renders a focusable <button>, so keyboard and
// touch users can open the tooltip — an `asChild` plain <span> could not. This
// shared trigger class carries the focus-visible ring token and keeps the
// button visually inline (no button chrome).
const TOOLTIP_TRIGGER_CLASS =
  "cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1";

const AdoptionCell = ({ adoption }: { adoption: PackAdoption | null }) => {
  if (!adoption) {
    return (
      <Tooltip>
        <TooltipTrigger
          className={`text-muted-foreground text-sm ${TOOLTIP_TRIGGER_CLASS}`}
        >
          Not available
        </TooltipTrigger>
        <TooltipContent>
          Per-member install status hasn't loaded for this distribution yet.
        </TooltipContent>
      </Tooltip>
    );
  }

  const pct = adoptionPercent(adoption);
  const fraction = `${NUMBER_FORMAT.format(adoption.installed)} of ${NUMBER_FORMAT.format(adoption.target)} installed`;
  const failedLabel = `${NUMBER_FORMAT.format(adoption.failed)} failed to install`;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <Progress
        aria-label={`Adoption: ${fraction} (${pct}%)`}
        className="w-16 shrink-0"
        value={pct}
      />
      <span className="shrink-0 text-sm tabular-nums">{pct}%</span>
      {adoption.failed > 0 ? (
        <Tooltip>
          <TooltipTrigger
            aria-label={failedLabel}
            className={`flex shrink-0 items-center gap-1 text-destructive text-xs tabular-nums ${TOOLTIP_TRIGGER_CLASS}`}
          >
            <TriangleAlertIcon aria-hidden="true" className="size-3" />
            {NUMBER_FORMAT.format(adoption.failed)}
          </TooltipTrigger>
          <TooltipContent>{failedLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
};

const ModeCell = ({ row }: { row: DistributedPackRow }) => {
  const meta = distributionModeMeta[row.mode];
  // The mode gloss is a tooltip on the label (keeps the cell to one line —
  // Option A) so "Required" / "Offered" isn't opaque jargon.
  return (
    <Tooltip>
      <TooltipTrigger className={`min-w-0 ${TOOLTIP_TRIGGER_CLASS}`}>
        <SourceStatusLine icon={meta.icon} text={meta.label} />
      </TooltipTrigger>
      <TooltipContent>{meta.gloss}</TooltipContent>
    </Tooltip>
  );
};

const UsageCell = ({ invocations }: { invocations: number | null }) =>
  invocations === null ? (
    <span className="text-muted-foreground text-sm">Not reported</span>
  ) : (
    <span className="text-sm tabular-nums">
      {NUMBER_FORMAT.format(invocations)}
    </span>
  );

const renderCell = (columnId: string, row: DistributedPackRow): ReactNode => {
  if (columnId === DistributedPackSortKey.Version) {
    return (
      <span className="truncate text-muted-foreground text-sm tabular-nums">
        {row.version}
      </span>
    );
  }
  if (columnId === DistributedPackSortKey.Mode) {
    return <ModeCell row={row} />;
  }
  if (columnId === DistributedPackSortKey.Adoption) {
    return <AdoptionCell adoption={row.adoption} />;
  }
  if (columnId === DistributedPackSortKey.Usage) {
    return <UsageCell invocations={row.invocations30d} />;
  }
  return null;
};

// The card the table falls back to below `md` so no column is silently clipped
// on a narrow surface (the grid scrolls horizontally at `md+`, cards below).
const renderCard = (
  row: DistributedPackRow,
  columns: readonly GridTableColumn[]
) => (
  <GridTableCard
    fields={buildGridTableCardFields(
      columns,
      CARD_EXCLUDED_COLUMNS,
      renderCell,
      row
    )}
    header={renderLead(row)}
  />
);

// The primary-table skeleton mirrors the grid's own row rhythm (lead + tracks),
// distinct from the secondary region's list-row skeleton, so a loading admin
// view reads as "a table is coming here", not a generic block.
const TableSkeleton = () => (
  <div className="flex flex-col gap-3" data-testid="distribute-table-skeleton">
    {[0, 1, 2, 3].map((rowKey) => (
      <div className="flex items-center gap-4" key={rowKey}>
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-16" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-16" />
      </div>
    ))}
  </div>
);

// The empty treatment lives inside the primary section (not a page-level
// return) so the secondary "Add packs" marketplace it points you to stays on
// screen — an admin with nothing distributed still sees the path forward.
const DistributedEmpty = () => (
  <EmptyState
    description="Distribute a pack from the catalog below to require or offer it across your org."
    icon={BlocksIcon}
    title="You're not distributing any packs yet"
  />
);

// A failed distributions read must NOT fall through to the empty state — an
// admin whose org depends on a required distribution can't be told they're
// distributing nothing. Surface the failure honestly (FEA-4088: never let the
// UI lie about data) while keeping the secondary Add-packs region on screen.
const DistributedError = () => (
  <Alert variant="error">
    <OctagonAlertIcon aria-hidden="true" />
    <AlertTitle>Couldn't load the packs you distribute</AlertTitle>
    <AlertDescription>
      This list failed to load, so it may be incomplete. Reload the page to try
      again — your distributions haven't changed.
    </AlertDescription>
  </Alert>
);

type DistributeTableProps = {
  readonly rows: readonly DistributedPackRow[];
};

const DistributeTable = ({ rows }: DistributeTableProps) => {
  const [sortBy, setSortBy] = useState<DistributedPackSortKey>(
    DistributedPackSortKey.Name
  );
  const [sortDir, setSortDir] = useState<SortDirection>("asc");

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        compareDistributedPackRows(a, b, sortBy, sortDir)
      ),
    [rows, sortBy, sortDir]
  );

  const handleSort = (column: string, direction: SortDirection) => {
    setSortBy(column as DistributedPackSortKey);
    setSortDir(direction);
  };

  return (
    <GridTable
      cardRender={renderCard}
      columns={ADMIN_COLUMNS}
      getRowId={(row) => row.id}
      gridTemplateColumns={ADMIN_GRID}
      items={sorted}
      leadingLabel="Pack"
      leadingSortKey={DistributedPackSortKey.Name}
      onSort={handleSort}
      renderCell={renderCell}
      renderLead={renderLead}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
};

type AdminViewProps = {
  /**
   * One row per active distribution (already built by the surface's data hook,
   * one per distribution — NOT folded per catalog item, so a catalog item with
   * multiple distributions shows every one).
   */
  readonly rows: readonly DistributedPackRow[];
  readonly isLoading?: boolean;
  /**
   * A failed catalog/distributions read. When set, the primary region shows an
   * honest failure state instead of the misleading "nothing distributed" empty
   * state — a required distribution the org depends on must never silently read
   * as "none" (FEA-4088: the UI must not lie about data).
   */
  readonly error?: Error | null;
  /**
   * The secondary marketplace / add-packs region — the existing discovery
   * workspace plus its create / upload / distribute / archive dialogs, passed
   * from the web app (they need the web data hooks). Demoted beneath the
   * manage-first table so discovery no longer outranks management.
   */
  readonly marketplaceSlot: ReactNode;
  /**
   * The member-vs-admin pack-permission boundary region (FEA-4084 —
   * `PackAdminBoundary`), passed from the web app. Rendered last (a reference
   * region beneath the admin's day-to-day manage + add work). Omitted when the
   * surface doesn't supply it.
   */
  readonly boundarySlot?: ReactNode;
};

export const AdminView = ({
  rows,
  isLoading = false,
  error = null,
  marketplaceSlot,
  boundarySlot,
}: AdminViewProps) => {
  const distributedBody = () => {
    if (isLoading) {
      return <TableSkeleton />;
    }
    // A failed read wins over the empty state: an incomplete list must read as
    // an error, never as "you distribute nothing".
    if (error) {
      return <DistributedError />;
    }
    if (rows.length === 0) {
      return <DistributedEmpty />;
    }
    return <DistributeTable rows={rows} />;
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
      <PageSection
        description="Packs you require or offer across your org, and how they're being adopted."
        title="Packs you distribute"
      >
        {distributedBody()}
      </PageSection>

      <PageSection
        description="Browse the catalog to add a pack to your org, then distribute it."
        title="Add packs"
      >
        {marketplaceSlot}
      </PageSection>

      {boundarySlot}
    </div>
  );
};
