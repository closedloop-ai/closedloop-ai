"use client";

import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { SessionsExportMenuItem } from "@repo/app/agents/components/sessions/sessions-options-menu";
/** Composes the shared list toolbar controls against a real Grid Table V2. */
import { ListSurfaceToolbarV2 } from "@repo/app/shared/components/list-surface-toolbar-v2";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  GRID_TABLE_METRIC_CARD_CLASS,
  GridTableListSurface,
  GridTableMetricStrip,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableChoiceCell,
  TableDateCell,
  TableNumberCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  TableModelCell,
  TableRepositoryCell,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import type { TableFiltersViewModel } from "@repo/design-system/components/ui/table-filters";
import { TableResetViewMenuItem } from "@repo/design-system/components/ui/table-options-menu-v2";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import { TableSavedViewsMenu } from "@repo/design-system/components/ui/table-saved-views-menu-v2";
import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { resolveColumnLayout } from "@repo/design-system/lib/column-layout";
import { createColumnRegistry } from "@repo/design-system/lib/column-registry";
import { useMemo, useState } from "react";
import {
  DEFAULT_VISIBLE_COLUMN_IDS,
  DEFAULT_VISIBLE_METRIC_KEYS,
  SESSION_COLUMN_DEFINITIONS,
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
import {
  buildDemoGroups,
  buildFilterController,
  captureViewState,
  type DemoViewState,
  initialSavedViewStates,
  isWithinDateRange,
  metricValue,
  sortDemoRows,
  toggleSetMember,
  toggleValue,
} from "./model";

/** Rows per page, small enough that the paginator has more than one page. */
const PAGE_SIZE = 4;
/** Width of the fixed leading identity column. */
const LEAD_COLUMN_WIDTH_PX = 260;
const SESSION_COLUMN_REGISTRY = createColumnRegistry(
  SESSION_COLUMN_DEFINITIONS
);

/**
 * The shared production list toolbar driving a real
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
  initialSortBy = null,
  initialStatuses = [],
  initialVisibleColumnIds = DEFAULT_VISIBLE_COLUMN_IDS,
  initialVisibleMetricKeys = DEFAULT_VISIBLE_METRIC_KEYS,
  layout = "none",
  withoutRange = false,
  withSearch = false,
}: {
  initialGrouping?: TableGroupingState;
  initialSortBy?: string | null;
  initialStatuses?: readonly string[];
  initialVisibleColumnIds?: readonly string[];
  initialVisibleMetricKeys?: readonly string[];
  /** "none" renders no List/Board toggle, as Sessions and Branches. */
  layout?: "board" | "list" | "none";
  /** Omit the range control, as a page with no time dimension. */
  withoutRange?: boolean;
  /** Render the shared "Filter items..." search. */
  withSearch?: boolean;
}) {
  const [dateRange, setDateRange] = useState("30d");
  const [searchText, setSearchText] = useState("");
  const [layoutValue, setLayoutValue] = useState<"board" | "list">(
    layout === "board" ? "board" : "list"
  );
  const [sortBy, setSortBy] = useState<string | null>(initialSortBy);
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [grouping, setGrouping] = useState(initialGrouping);
  const [statuses, setStatuses] = useState<string[]>([...initialStatuses]);
  const [owners, setOwners] = useState<string[]>([]);
  const [visibleColumnIds, setVisibleColumnIds] = useState(
    () => new Set(initialVisibleColumnIds)
  );
  const [visibleMetricKeys, setVisibleMetricKeys] = useState(
    () => new Set(initialVisibleMetricKeys)
  );
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(
    null
  );
  const [savedViews, setSavedViews] = useState([...SESSION_SAVED_VIEWS]);
  const [savedViewStates, setSavedViewStates] = useState<
    Readonly<Record<string, DemoViewState>>
  >(() => initialSavedViewStates());
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () =>
      SESSION_ROWS.filter(
        (row) =>
          (withoutRange || isWithinDateRange(row, dateRange)) &&
          row.name.toLowerCase().includes(searchText.trim().toLowerCase()) &&
          (statuses.length === 0 || statuses.includes(row.status)) &&
          (owners.length === 0 || owners.includes(row.owner))
      ),
    [dateRange, searchText, statuses, owners, withoutRange]
  );
  const sorted = useMemo(
    () => sortDemoRows(filtered, sortBy, sortDir),
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
    () => (isGrouped ? buildDemoGroups(sorted, grouping) : undefined),
    [isGrouped, sorted, grouping]
  );

  const columnLayout = useMemo(
    () =>
      resolveColumnLayout(
        SESSION_COLUMN_REGISTRY,
        {
          hiddenColumnIds: SESSION_COLUMN_DEFINITIONS.filter(
            (definition) => !visibleColumnIds.has(definition.id)
          ).map((definition) => definition.id),
        },
        { leadingTracks: [`${LEAD_COLUMN_WIDTH_PX}px`] }
      ),
    [visibleColumnIds]
  );

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
  const resetView = () => {
    setDateRange("30d");
    setSortBy(null);
    setSortDir("asc");
    setGrouping(EMPTY_TABLE_GROUPING);
    setStatuses([]);
    setOwners([]);
    setVisibleColumnIds(new Set(DEFAULT_VISIBLE_COLUMN_IDS));
    setVisibleMetricKeys(new Set(DEFAULT_VISIBLE_METRIC_KEYS));
    setActiveSavedViewId(null);
    setPage(0);
  };

  const applySavedView = (viewId: string) => {
    const snapshot = savedViewStates[viewId];
    if (!snapshot) {
      return;
    }
    setDateRange(snapshot.dateRange);
    setSortBy(snapshot.sortBy);
    setSortDir(snapshot.sortDir);
    setGrouping(snapshot.grouping);
    setStatuses([...snapshot.statuses]);
    setOwners([...snapshot.owners]);
    setVisibleColumnIds(new Set(snapshot.visibleColumnIds));
    setVisibleMetricKeys(new Set(snapshot.visibleMetricKeys));
    setActiveSavedViewId(viewId);
    setPage(0);
  };

  const saveCurrentView = (name: string) => {
    const id = `view_${name.toLowerCase().replaceAll(" ", "-")}`;
    setSavedViews((current) => [
      ...current.filter((view) => view.id !== id),
      { id, name, scope: TableSavedViewScope.Personal },
    ]);
    setSavedViewStates((current) => ({
      ...current,
      [id]: captureViewState({
        dateRange,
        grouping,
        owners,
        sortBy,
        sortDir,
        statuses,
        visibleColumnIds,
        visibleMetricKeys,
      }),
    }));
    setActiveSavedViewId(id);
  };

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
          columns={columnLayout.columns}
          getRowId={(row) => row.id}
          gridTemplateColumns={columnLayout.gridTemplateColumns}
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
        <ListSurfaceToolbarV2
          activeFiltersViewModel={filterViewModel}
          columns={SESSION_COLUMNS}
          dateRange={withoutRange ? undefined : dateRange}
          dateRangeOptions={SESSION_DATE_RANGES}
          filterController={filterController}
          filtersActive={filtersActive}
          filterViewModel={filterViewModel}
          layoutToggle={
            layout === "none"
              ? undefined
              : { onChange: setLayoutValue, value: layoutValue }
          }
          metrics={SESSION_METRICS}
          onAddField={() => undefined}
          onClearFilters={filterController.clearAllFilters}
          onDateRangeChange={(nextDateRange) => {
            setDateRange(nextDateRange);
            setPage(0);
          }}
          onToggleColumn={toggleColumn}
          onToggleMetric={toggleMetric}
          optionsTrailing={
            <>
              <SessionsExportMenuItem onExport={() => undefined} />
              <TableResetViewMenuItem onSelect={resetView} />
            </>
          }
          savedViews={
            <TableSavedViewsMenu
              activeViewId={activeSavedViewId}
              onApply={applySavedView}
              onSave={saveCurrentView}
              views={savedViews}
            />
          }
          search={
            withSearch
              ? {
                  onChange: (next) => {
                    setSearchText(next);
                    setPage(0);
                  },
                  value: searchText,
                }
              : undefined
          }
          sortGrouping={{
            allowEmptyGroups: false,
            grouping,
            groupOptions: SESSION_GROUP_OPTIONS,
            maxSortRules: 1,
            onClearSort: clearSort,
            onGroupingChange: setGrouping,
            onSort: (fieldId, direction) => {
              setSortBy(fieldId);
              setSortDir(direction ?? "asc");
            },
            onSortsChange: (sorts) => {
              const first = sorts[0];
              setSortBy(first?.fieldId ?? null);
              setSortDir(first?.direction ?? "asc");
            },
            sortBy,
            sortOptions: SESSION_SORT_OPTIONS,
            sorts:
              sortBy === null ? [] : [{ direction: sortDir, fieldId: sortBy }],
          }}
          visibleColumnIds={visibleColumnIds}
          visibleMetricKeys={visibleMetricKeys}
        />
      }
    />
  );
}

function renderSessionCell(columnId: string, row: SessionRow) {
  switch (columnId) {
    case "owner":
      return <TablePersonCell person={{ name: row.owner }} />;
    case "status":
      return <TableChoiceCell label={SESSION_STATUS_LABELS[row.status]} />;
    case "repository":
      return (
        <TableRepositoryCell
          fullName={row.repository}
          label={repositoryLabel(row.repository)}
        />
      );
    case "model":
      return <TableModelCell model={row.model} />;
    case "cost":
      return <TableNumberCell value={`$${row.cost.toFixed(2)}`} />;
    case "duration":
      return <TableNumberCell value={row.duration} />;
    case "updated":
      return <TableDateCell fullValue={row.updatedAt} value={row.updated} />;
    default:
      return <GridEmptyValue />;
  }
}

function repositoryLabel(repository: string): string {
  return repository.slice(repository.lastIndexOf("/") + 1);
}
