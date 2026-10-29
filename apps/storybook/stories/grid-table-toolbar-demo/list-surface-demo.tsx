"use client";

/**
 * Composes the Grid Table V2 toolbar family — this is where
 * `active-filters-bar-v2.tsx` and `filter-popover-v2.tsx` get their Storybook
 * coverage. They render here rather than in their own isolated story files:
 * each has a same-named but unrelated sibling in `active-filters-bar.tsx` /
 * `filter-popover.tsx` (the classic document-table system), and those two
 * files' stories carry a comment pointing here.
 */
import { ActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar-v2";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover-v2";
import {
  GRID_TABLE_METRIC_CARD_CLASS,
  GridTableListSurface,
  GridTableMetricStrip,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableToolbar } from "@repo/design-system/components/ui/grid-table-toolbar";
import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableCompactViewMenu } from "@repo/design-system/components/ui/table-compact-view-menu-v2";
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters-v2";
import { TableGroupMenu } from "@repo/design-system/components/ui/table-group-menu-v2";
import { TableOptionsMenu } from "@repo/design-system/components/ui/table-options-menu-v2";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import { TableSavedViewsMenu } from "@repo/design-system/components/ui/table-saved-views-menu-v2";
import { TableSortMenu } from "@repo/design-system/components/ui/table-sort-menu-v2";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { TableDateRangeToggle } from "@repo/design-system/components/ui/table-toolbar-toggles-v2";
import { DownloadIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DEFAULT_VISIBLE_COLUMN_IDS,
  DEFAULT_VISIBLE_METRIC_KEYS,
  SESSION_COLUMN_WIDTHS,
  SESSION_COLUMNS,
  SESSION_DATE_RANGES,
  SESSION_GROUP_OPTIONS,
  SESSION_METRICS,
  SESSION_OWNER_OPTIONS,
  SESSION_ROWS,
  SESSION_SAVED_VIEWS,
  SESSION_SORT_OPTIONS,
  SESSION_STATUS_OPTIONS,
  type SessionRow,
} from "./fixtures";

/** Rows per page, small enough that the paginator has more than one page. */
const PAGE_SIZE = 4;
/** Width of the fixed leading identity column. */
const LEAD_COLUMN_WIDTH_PX = 260;

/**
 * The v2 list surface end to end: `GridTableToolbar` driving a real
 * `GridTableV2`, with the metric-card summary row between them and
 * `TablePagination` beneath.
 *
 * Everything is really wired. A story that stubs the callbacks can show that
 * the toolbar RENDERS, but the thing worth reviewing is whether the toolbar's
 * state model actually drives a table — whether choosing a group field produces
 * groups, whether hiding a column drops its grid track, whether a filter
 * narrows the rows the paginator counts. Those are the seams a promotion
 * breaks, so they are what this demonstrates.
 */
export function ListSurfaceDemo({
  initialGrouping = EMPTY_TABLE_GROUPING,
  initialStatuses = [],
}: {
  initialGrouping?: TableGroupingState;
  initialStatuses?: readonly string[];
}) {
  const [dateRange, setDateRange] = useState("30d");
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [grouping, setGrouping] = useState(initialGrouping);
  const [statuses, setStatuses] = useState<string[]>([...initialStatuses]);
  const [owners, setOwners] = useState<string[]>([]);
  const [visibleColumnIds, setVisibleColumnIds] = useState(
    () => new Set(DEFAULT_VISIBLE_COLUMN_IDS)
  );
  const [visibleMetricKeys, setVisibleMetricKeys] = useState(
    () => new Set(DEFAULT_VISIBLE_METRIC_KEYS)
  );
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(
    null
  );
  const [savedViews, setSavedViews] = useState([...SESSION_SAVED_VIEWS]);
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () =>
      SESSION_ROWS.filter(
        (row) =>
          (statuses.length === 0 || statuses.includes(row.status)) &&
          (owners.length === 0 || owners.includes(row.owner))
      ),
    [statuses, owners]
  );
  const sorted = useMemo(
    () => sortRows(filtered, sortBy, sortDir),
    [filtered, sortBy, sortDir]
  );

  // Grouping and pagination are mutually exclusive: a page boundary that cuts
  // through a group renders a section header with rows missing from beneath it,
  // which reads as data loss. The prototype hides the paginator when grouped
  // and shows every row; this keeps that rule.
  const isGrouped = grouping.primary.fieldId !== null;
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pagedRows = isGrouped
    ? sorted
    : sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const groups = useMemo(
    () => (isGrouped ? buildGroups(sorted, grouping) : undefined),
    [isGrouped, sorted, grouping]
  );

  const columns: GridTableV2Column[] = SESSION_COLUMNS.filter((column) =>
    visibleColumnIds.has(column.key)
  ).map((column) => ({
    id: column.key,
    label: column.label,
    sortable: SESSION_SORT_OPTIONS.some((option) => option.id === column.key),
    groupable: SESSION_GROUP_OPTIONS.some((option) => option.id === column.key),
    filterable: column.key === "status" || column.key === "owner",
  }));
  // The caller owns the grid tracks, so hiding a column has to drop its track
  // too — otherwise the header and body keep a phantom empty column.
  const gridTemplateColumns = [
    `${LEAD_COLUMN_WIDTH_PX}px`,
    ...columns.map((column) => `${SESSION_COLUMN_WIDTHS[column.id] ?? 120}px`),
  ].join(" ");

  const filterController = buildFilterController({
    onClearAll: () => {
      setStatuses([]);
      setOwners([]);
      setPage(0);
    },
    setOwners: (next) => {
      setOwners(next);
      setPage(0);
    },
    setStatuses: (next) => {
      setStatuses(next);
      setPage(0);
    },
    statuses,
  });
  const filterViewModel: TableFiltersViewModel = {
    teamMembers: [],
    statusOptions: [],
    priorityOptions: [],
    hideQuickToggles: true,
    facetGroups: [
      {
        id: "status",
        label: "Status",
        options: [...SESSION_STATUS_OPTIONS],
        selectedValues: statuses,
        onToggle: (value) => {
          setStatuses(toggleValue(statuses, value));
          setPage(0);
        },
      },
      {
        id: "owner",
        label: "Owner",
        options: [...SESSION_OWNER_OPTIONS],
        selectedValues: owners,
        onToggle: (value) => {
          setOwners(toggleValue(owners, value));
          setPage(0);
        },
      },
    ],
  };
  const filtersActive = statuses.length > 0 || owners.length > 0;

  const clearSort = () => {
    setSortBy(null);
    setSortDir("asc");
  };
  const toggleColumn = (columnId: string) =>
    setVisibleColumnIds((current) => toggleSetMember(current, columnId));
  const toggleMetric = (metricKey: string) =>
    setVisibleMetricKeys((current) => toggleSetMember(current, metricKey));

  return (
    <GridTableListSurface
      metrics={
        visibleMetricKeys.size > 0 ? (
          <GridTableMetricStrip>
            {SESSION_METRICS.filter((metric) =>
              visibleMetricKeys.has(metric.key)
            ).map((metric) => (
              <MetricCard
                className={GRID_TABLE_METRIC_CARD_CLASS}
                key={metric.key}
                label={metric.label}
                value={metricValue(metric.key, filtered)}
              />
            ))}
          </GridTableMetricStrip>
        ) : null
      }
      pagination={
        isGrouped ? null : (
          <TablePagination
            onPageChange={setPage}
            page={page}
            totalPages={totalPages}
          />
        )
      }
      table={
        <GridTableV2<SessionRow>
          columns={columns}
          getRowId={(row) => row.id}
          gridTemplateColumns={gridTemplateColumns}
          groups={groups}
          items={groups ? [] : pagedRows}
          leadingLabel="Session"
          leadingSortKey="name"
          onSort={(fieldId, direction) => {
            setSortBy(fieldId);
            setSortDir(direction);
          }}
          renderCell={(columnId, row) => renderSessionCell(columnId, row)}
          renderLead={(row) => (
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">{row.name}</div>
              <div className="truncate text-muted-foreground text-xs">
                {row.slug}
              </div>
            </div>
          )}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      }
      toolbar={
        <GridTableToolbar
          activeFilters={
            filtersActive ? (
              <div className="-mx-4">
                <ActiveFiltersBar
                  controller={filterController}
                  viewModel={filterViewModel}
                />
              </div>
            ) : null
          }
          compact={
            <TableCompactViewMenu
              columns={SESSION_COLUMNS}
              grouping={grouping}
              groupOptions={SESSION_GROUP_OPTIONS}
              metrics={SESSION_METRICS}
              onAddField={noop}
              onClearSort={clearSort}
              onGroupingChange={setGrouping}
              onSort={setSortBy}
              onToggleColumn={toggleColumn}
              onToggleMetric={toggleMetric}
              sortBy={sortBy}
              sortOptions={SESSION_SORT_OPTIONS}
              trailing={<DemoExportMenuItem />}
              visibleColumnIds={visibleColumnIds}
              visibleMetricKeys={visibleMetricKeys}
            />
          }
          expanded={
            <>
              <TableSortMenu
                onClear={clearSort}
                onSort={(fieldId, direction) => {
                  setSortBy(fieldId);
                  setSortDir(direction);
                }}
                options={SESSION_SORT_OPTIONS}
                sortBy={sortBy}
              />
              <TableGroupMenu
                grouping={grouping}
                onGroupingChange={setGrouping}
                options={SESSION_GROUP_OPTIONS}
              />
              <TableOptionsMenu
                columns={SESSION_COLUMNS}
                metrics={SESSION_METRICS}
                onAddField={noop}
                onToggleColumn={toggleColumn}
                onToggleMetric={toggleMetric}
                trailing={<DemoExportMenuItem />}
                visibleColumnIds={visibleColumnIds}
                visibleMetricKeys={visibleMetricKeys}
              />
              <TableSavedViewsMenu
                activeViewId={activeSavedViewId}
                onApply={setActiveSavedViewId}
                onSave={(name) => {
                  const id = `view_${name.toLowerCase().replaceAll(" ", "-")}`;
                  setSavedViews((current) => [
                    ...current,
                    { id, name, scope: "personal" },
                  ]);
                  setActiveSavedViewId(id);
                }}
                views={savedViews}
              />
            </>
          }
          leading={
            <>
              <TableDateRangeToggle
                onValueChange={setDateRange}
                options={SESSION_DATE_RANGES}
                value={dateRange}
              />
              <FilterPopover
                controller={filterController}
                onClear={filterController.clearAllFilters}
                viewModel={filterViewModel}
              />
            </>
          }
        />
      }
    />
  );
}

function renderSessionCell(columnId: string, row: SessionRow) {
  if (columnId === "cost") {
    return <span className="text-sm tabular-nums">${row.cost.toFixed(2)}</span>;
  }
  const value = row[columnId as keyof SessionRow];
  return <span className="truncate text-sm">{String(value ?? "")}</span>;
}

function metricValue(metricKey: string, rows: readonly SessionRow[]): string {
  if (metricKey === "spend") {
    const total = rows.reduce((sum, row) => sum + row.cost, 0);
    return `$${total.toFixed(2)}`;
  }
  if (metricKey === "active") {
    return String(rows.filter((row) => row.status === "Active").length);
  }
  if (metricKey === "failures") {
    return String(rows.filter((row) => row.status === "Failed").length);
  }
  return String(rows.length);
}

function sortRows(
  rows: readonly SessionRow[],
  sortBy: string | null,
  direction: SortDirection
): SessionRow[] {
  if (sortBy === null) {
    return [...rows];
  }
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortBy === "name" ? a.name : a[sortBy as keyof SessionRow];
    const right = sortBy === "name" ? b.name : b[sortBy as keyof SessionRow];
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * sign;
    }
    return String(left).localeCompare(String(right)) * sign;
  });
}

/**
 * Build the grid's group tree from the toolbar's grouping state. Two levels
 * deep, matching what `TableGroupMenu` can express and what `GridTableV2`
 * renders (`GridTableV2Group.subgroups`).
 */
function buildGroups(
  rows: readonly SessionRow[],
  grouping: TableGroupingState
): GridTableV2Group<SessionRow>[] {
  const primaryField = grouping.primary.fieldId;
  if (primaryField === null) {
    return [];
  }
  const secondaryField = grouping.secondary.fieldId;
  return partition(rows, primaryField, grouping.primary.order).map(
    ([key, items]) => ({
      key,
      label: key,
      items,
      subgroups:
        secondaryField === null
          ? undefined
          : partition(items, secondaryField, grouping.secondary.order).map(
              ([subKey, subItems]) => ({
                key: subKey,
                label: subKey,
                items: subItems,
              })
            ),
    })
  );
}

function partition(
  rows: readonly SessionRow[],
  field: string,
  order: TableGroupOrder
): [string, SessionRow[]][] {
  const buckets = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = String(row[field as keyof SessionRow] ?? "—");
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  const entries = [...buckets.entries()];
  if (order === TableGroupOrder.Custom) {
    // "Custom" is insertion order — the order the rows already arrived in,
    // which is the caller's own ranking rather than a comparison.
    return entries;
  }
  const sign = order === TableGroupOrder.Ascending ? 1 : -1;
  return entries.sort(([a], [b]) => a.localeCompare(b) * sign);
}

function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function toggleSetMember(
  current: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * A `TableFiltersController` over the demo's two facets.
 *
 * `activeChips` is deliberately EMPTY, and the chip row still works. The demo
 * drives its filters entirely through `viewModel.facetGroups` — which is how
 * the Sessions and Branches toolbars drive theirs, both of them paired with a
 * no-op controller — and `ActiveFiltersBar` now derives chips from those facet
 * groups directly. An earlier revision of this demo hand-built `activeChips`
 * mirroring each facet, which papered over the fact that the bar could not see
 * `facetGroups` at all; deleting that mirror is what proves the fix.
 *
 * The built-in categories (assignee, priority, date, tags) stay inert here for
 * the same reason they are inert in production: `facetGroups` REPLACES them.
 */
function buildFilterController({
  onClearAll,
  setOwners,
  setStatuses,
  statuses,
}: {
  onClearAll: () => void;
  setOwners: (next: string[]) => void;
  setStatuses: (next: string[]) => void;
  statuses: readonly string[];
}): TableFiltersController {
  return {
    filters: {
      assigneeIds: [],
      assignToMe: false,
      hideCompletedItems: false,
      favoritesOnly: false,
      statuses: [...statuses],
      priorities: [],
      date: null,
      tagIds: [],
    },
    toggleAssignee: () => undefined,
    toggleAssignToMe: () => undefined,
    toggleHideCompletedItems: () => undefined,
    toggleFavoritesOnly: () => undefined,
    toggleStatus: (status) => setStatuses(toggleValue(statuses, status)),
    togglePriority: () => undefined,
    setDateFilter: () => undefined,
    toggleTag: () => undefined,
    clearCategoryFilter: (category) => {
      if (category === "status") {
        setStatuses([]);
      }
      if (category === "assignee") {
        setOwners([]);
      }
    },
    clearAllFilters: onClearAll,
    activeChips: [],
  };
}

/** A demo action with nothing behind it; the stories exist to show the row. */
function noop() {
  return;
}

/**
 * Stand-in for a surface's own export row, so both menus render the `trailing`
 * slot they accept.
 *
 * It is here rather than only on the wide menu because the two menus SWAP at
 * `md` — `CompactWidth` is the story where that matters, and a slot exercised at
 * one width only is how a control comes to disappear when the window narrows.
 * The item emits its own leading separator, matching the real
 * `SessionsExportMenuItem`, so the section rhythm the story shows is the one a
 * production surface gets.
 */
function DemoExportMenuItem() {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
        <DownloadIcon />
        Export CSV
      </DropdownMenuItem>
    </>
  );
}
