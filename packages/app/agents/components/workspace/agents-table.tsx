"use client";

/**
 * Agents workspace inventory table (T-3.1).
 *
 * Sortable GridTable with columns: Name (lead), Type, Metric, Owner,
 * Collaborators, Source, Harness, Invocations, Sessions, Actions.
 *
 * Badge/label helpers imported from packages/app/agents/lib/component-meta.tsx.
 * Row data and sort/select handlers come from props — no direct mock imports.
 *
 * Domain component: lives in this feature slice, NOT in @closedloop-ai/design-system.
 */

import {
  type AgentComponent,
  type AgentComponentSortDir,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
  type GridTableGroup,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  CollaboratorStack,
  isNewlyDiscovered,
  KindBadge,
  KlocValue,
  NewBadge,
  NUMBER_FORMAT,
  OwnerLabel,
  SourceLabel,
} from "../../lib/component-meta";
import { HarnessBadge } from "../session-status-badges";

// ---------------------------------------------------------------------------
// Column specs
// ---------------------------------------------------------------------------

const LEAD_WIDTH = "minmax(240px, 1fr)";

type ColumnSpec = GridTableColumn & { width: string };

const COLUMN_SPECS: readonly ColumnSpec[] = [
  { id: "type", label: "Type", width: "132px", sortable: true },
  { id: "metric", label: "KLOC / $", width: "132px", sortable: true },
  { id: "owner", label: "Owner", width: "168px", sortable: true },
  {
    id: "collaborators",
    label: "Collaborators",
    width: "148px",
    sortable: false,
  },
  { id: "source", label: "Source", width: "196px", sortable: true },
  { id: "harness", label: "Harness", width: "150px", sortable: true },
  { id: "invocations", label: "Invocations", width: "120px", sortable: true },
  { id: "sessions", label: "Sessions", width: "108px", sortable: true },
];

const ACTIONS_SPEC: ColumnSpec = {
  id: "actions",
  label: "",
  width: "52px",
  sortable: false,
};

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

const NumberCell = ({ value }: { value: number | null }): ReactNode =>
  value === null ? (
    <GridEmptyValue />
  ) : (
    <span className="text-sm tabular-nums">{NUMBER_FORMAT.format(value)}</span>
  );

const ActionsCell = (): ReactNode => (
  <div className="flex w-full items-center justify-end opacity-0 transition-opacity group-hover:opacity-100">
    <button
      aria-label="More actions"
      className="rounded-md p-1 text-muted-foreground hover:bg-muted"
      type="button"
    >
      <EllipsisIcon className="size-4" />
    </button>
  </div>
);

// ---------------------------------------------------------------------------
// Metric cell — driven by metricMode prop
// ---------------------------------------------------------------------------

const MetricCell = ({
  component,
  metricMode,
}: {
  component: AgentComponent;
  metricMode: AgentMetricMode;
}): ReactNode => {
  const value = component.klocPerDollar;
  if (value === null) {
    return <GridEmptyValue />;
  }
  // Phase 1: all three metric modes use klocPerDollar as the backing value.
  // DollarPerKloc and ValueIndex are intentional follow-up transformations.
  switch (metricMode) {
    case AgentMetricMode.DollarPerKloc:
      return (
        <KlocValue
          value={value > 0 ? Math.round((1 / value) * 100) / 100 : null}
        />
      );
    case AgentMetricMode.ValueIndex:
      return <KlocValue value={value} />;
    default:
      return <KlocValue value={value} />;
  }
};

// ---------------------------------------------------------------------------
// Live activity dot (FEA-3179)
// ---------------------------------------------------------------------------

/**
 * A component whose most recent ACTUAL invocation (`lastInvokedAt`) falls within
 * this many milliseconds of "now" is treated as currently-active and gets the
 * animated "live" dot in the Name lead cell. 60 minutes — long enough that an
 * in-progress or just-finished session still reads as live, short enough to
 * distinguish it from stale rows.
 */
const ACTIVE_RECENCY_WINDOW_MS = 60 * 60 * 1000;

/**
 * True when the component's real last-invocation time is within the active
 * window of now.
 *
 * FEA-3179 keys off `lastInvokedAt` (max usage `lastInvokedAt` from the service),
 * NOT `lastSeenAt`: `lastSeenAt` is an inventory-observation time the pack
 * scanner refreshes to `now()` on every sync for every still-installed
 * component, so keying off it would light the dot for EVERY installed component
 * — a meaningless signal (same root cause as the FEA-3160 windowing bug). When
 * `lastInvokedAt` is absent (no usage rows, e.g. configured-only kinds, or a
 * surface like desktop that does not project it), the component is never treated
 * as active and no dot renders.
 */
function isRecentlyActive(lastInvokedAt: string | undefined): boolean {
  if (!lastInvokedAt) {
    return false;
  }
  const invoked = Date.parse(lastInvokedAt);
  if (Number.isNaN(invoked)) {
    return false;
  }
  return Date.now() - invoked <= ACTIVE_RECENCY_WINDOW_MS;
}

/**
 * Subtle animated dot marking a component as active in the last hour. Reuses the
 * shared `ob-pulse` opacity animation (packages/app/styles.css) — same keyframes
 * the desktop first-launch banner drives, so no new animation is introduced.
 * Presentational only; shrink-0 keeps it from perturbing the name's truncation.
 */
const ActiveDot = (): ReactNode => (
  <span
    aria-label="Active in the last hour"
    className="size-1.5 shrink-0 rounded-full bg-[var(--primary)]"
    data-testid="agent-active-dot"
    role="img"
    style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
    title="Active in the last hour"
  />
);

// ---------------------------------------------------------------------------
// Name lead — navigates to the component detail page when href is provided
// ---------------------------------------------------------------------------

function renderNameLead(
  component: AgentComponent,
  getComponentHref?: (item: AgentComponent) => string
): ReactNode {
  const label = (
    <span className="truncate font-medium text-sm">{component.name}</span>
  );

  const name = getComponentHref ? (
    <a className="min-w-0 hover:underline" href={getComponentHref(component)}>
      {label}
    </a>
  ) : (
    label
  );

  // Trailing indicators, composed independently so a single row can carry BOTH:
  //   • FEA-3176: a "New" chip when discovered in the last 7 days.
  //   • FEA-3179: an animated "live" dot when invoked in the last hour — keyed
  //     off the real `lastInvokedAt`, never the sync-refreshed `lastSeenAt`.
  const isNew = isNewlyDiscovered(component.firstSeenAt);
  const isActive = isRecentlyActive(component.lastInvokedAt);
  if (!(isNew || isActive)) {
    return name;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {name}
      {isNew ? <NewBadge /> : null}
      {isActive ? <ActiveDot /> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AgentsTable
// ---------------------------------------------------------------------------

export type AgentsTableGroup = GridTableGroup<AgentComponent>;

export type AgentsTableProps = {
  items: AgentComponent[];
  /**
   * Pre-computed groups for the grouped layout. When provided, `items` is
   * ignored and the table renders one collapsible section per group.
   */
  groups?: AgentsTableGroup[];
  /** Sort column id currently active. */
  sortBy: string;
  /** Sort direction currently active. */
  sortDir: AgentComponentSortDir;
  /** Fired when the user clicks a sortable column header. */
  onSort: (col: string, dir: AgentComponentSortDir) => void;
  /**
   * Set of column ids that should be visible. When provided, columns not in
   * this set are omitted (the column and its grid track are dropped together).
   * When absent, all columns are visible.
   */
  visibleColumns?: Set<string>;
  /**
   * When provided, clicking a row's Name lead navigates to the returned href
   * (a plain anchor — no platform-specific Link component needed for the lead
   * cell; callers on web inject a Next.js router href string).
   */
  getComponentHref?: (item: AgentComponent) => string;
  /** Which efficiency metric the Metric column displays. */
  metricMode: AgentMetricMode;
  /**
   * Whether GitHub data is connected. When false, unattributed-owner rows show
   * the Connect-GitHub CTA in the Owner column (governing design FEA-2923);
   * undefined (unknown, e.g. desktop or pre-fetch) falls back to a plain "—".
   */
  githubConnected?: boolean;
  /** Hard-navigation connect target passed to the Owner-column CTA (web only). */
  githubConnectHref?: string;
};

export function AgentsTable({
  items,
  groups,
  sortBy,
  sortDir,
  onSort,
  visibleColumns,
  getComponentHref,
  metricMode,
  githubConnected,
  githubConnectHref,
}: AgentsTableProps): ReactNode {
  // Filter data columns by visibility, then append the always-visible actions
  // column. The actions column is not toggleable so it lives outside COLUMN_SPECS.
  const dataSpecs = visibleColumns
    ? COLUMN_SPECS.filter((spec) => visibleColumns.has(spec.id))
    : COLUMN_SPECS;
  const specs = [...dataSpecs, ACTIONS_SPEC];

  const columns: GridTableColumn[] = specs.map(({ width: _w, ...col }) => col);

  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");

  // Adapt AgentComponentSortDir → GridTable's SortDirection string union.
  const sortDirNormalized: SortDirection = sortDir === "desc" ? "desc" : "asc";

  const handleSort = (col: string, dir: SortDirection): void => {
    onSort(col, dir as AgentComponentSortDir);
  };

  return (
    <GridTable<AgentComponent>
      columns={columns}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      groups={groups}
      items={items}
      leadingLabel="Component"
      leadingSortKey="name"
      onSort={handleSort}
      renderCell={(columnId, item) =>
        renderCell(columnId, item, {
          metricMode,
          githubConnected,
          githubConnectHref,
        })
      }
      renderLead={(item) => renderNameLead(item, getComponentHref)}
      sortBy={sortBy}
      sortDir={sortDirNormalized}
    />
  );
}

type RenderCellOptions = {
  metricMode: AgentMetricMode;
  githubConnected?: boolean;
  githubConnectHref?: string;
};

function renderCell(
  columnId: string,
  component: AgentComponent,
  { metricMode, githubConnected, githubConnectHref }: RenderCellOptions
): ReactNode {
  switch (columnId) {
    case "type":
      return <KindBadge kind={component.kind} />;
    case "metric":
      return <MetricCell component={component} metricMode={metricMode} />;
    case "owner":
      return (
        <OwnerLabel
          component={component}
          githubConnected={githubConnected}
          githubConnectHref={githubConnectHref}
        />
      );
    case "collaborators":
      return <CollaboratorStack users={component.collaborators} />;
    case "source":
      return <SourceLabel component={component} />;
    case "harness":
      return <HarnessBadge harness={component.harness} />;
    case "invocations":
      return <NumberCell value={component.invocations} />;
    case "sessions":
      return <NumberCell value={component.sessions} />;
    case "actions":
      return <ActionsCell />;
    default:
      return null;
  }
}
