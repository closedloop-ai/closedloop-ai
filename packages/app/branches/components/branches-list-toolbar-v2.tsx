"use client";

import type { BranchListSortKey } from "@repo/api/src/types/branch-list-contract";
import type { GridTableListSurfaceMode } from "@repo/design-system/components/ui/grid-table-list-surface";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableResetViewMenuItem } from "@repo/design-system/components/ui/table-options-menu-v2";
import type {
  TableGroupingState,
  TableSortRule,
  TableToggleOption,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { isListCustomFieldColumnId } from "../../custom-fields/lib/list-custom-field-columns";
import type { ListSurfaceSortGrouping } from "../../shared/components/list-surface-toolbar-parts";
import { ListSurfaceToolbarV2 } from "../../shared/components/list-surface-toolbar-v2";
import { TimezoneModeFilter } from "../../shared/components/timezone-mode-filter";
import type { ColumnViewModel } from "../../shared/lib/column-view-model";
import {
  admitFilterableGroups,
  groupableColumnOptions,
  sortableColumnOptions,
} from "../../shared/lib/column-view-model";
import { DEFAULT_TIMEZONE_MODE } from "../../shared/lib/date-window-timezone-mode";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "../../shared/lib/facet-filter";
import { parseDateRange } from "../../shared/lib/format-utils";
import { TABLE_DATE_RANGE_OPTIONS } from "../../shared/lib/table-date-range-options";
import {
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
  BRANCH_TOGGLEABLE_COLUMNS,
  type BranchColumnId,
} from "../hooks/use-branch-view-state";
import {
  BRANCH_COLUMN_VIEW_MODEL,
  branchSortKeyForColumn,
  branchSortRules,
  resolveBranchSortColumnId,
  withoutBranchPriorityColumn,
  withoutBranchProjectColumn,
  withoutBranchTagsColumn,
} from "../lib/branch-column-view-model";
import { DEFAULT_BRANCH_FILTERS } from "../lib/branch-row";
import {
  branchesSummaryCardOptions,
  resolveBranchesSummaryCardVisibility,
} from "../lib/branches-summary-card-visibility";
import { useBranchMetricLabels } from "../lib/use-branch-metric-labels";
import type { BranchesCustomFieldColumns } from "./branch-custom-field-columns";
import {
  type BranchesPriorityColumnOptIn,
  type BranchesProjectColumnOptIn,
  type BranchesTagsColumnOptIn,
  type BranchesToolbarProps,
  useBranchToolbarFacetGroups,
} from "./branches-toolbar-model";

/**
 * ISS-9225 — the Branches list's Grid Table v2 toolbar.
 *
 * Branches shipped its v2 surface with no toolbar of its own: the surface took
 * an opaque `ReactNode` and every host injected the V1 toolbar, so there was no
 * canonical v2 toolbar for Sessions' to be consistent WITH. This is that
 * toolbar, and it is not a second implementation — it hands the same
 * `ListSurfaceToolbarV2` Sessions renders the arguments a branch list has.
 *
 * It takes {@link BranchesToolbarProps} verbatim, so every host and this toolbar
 * read ONE contract: a host builds the props once and hands them straight here.
 *
 * ISS-10301 retired the rollout gate that sentence used to name, along with the
 * deliberately-aligned v1 `SessionsToolbar` / `BranchesToolbar` pair whose
 * consistency this toolbar was written to restore. There is one Branches arm now
 * and `BranchesToolbarProps` lives in `./branches-toolbar-model`, the props half
 * of that retired pair.
 *
 * ISS-9676: sort and grouping are no longer absent. They arrive as
 * `sortGrouping`, derived from {@link BRANCH_COLUMN_VIEW_MODEL} rather than
 * hand-listed here — the historical blocker was that `ListSurfaceSortGrouping`
 * is one indivisible cluster and this list had no grouping vocabulary, so
 * reaching the Sort menu would also have rendered a Group menu over nothing.
 * The view model supplies both, and `columnControls` being absent still omits
 * grouping from the cluster. Sorting remains available because the responsive
 * card layout has no sortable column headers of its own. In the expanded grid,
 * the headers own Sort and this toolbar renders only Group and Options.
 */
export function BranchesListToolbarV2({
  approved = false,
  columnControls,
  columnViewModel: declaredColumnViewModel = BRANCH_COLUMN_VIEW_MODEL,
  customFieldColumns,
  dateRange,
  facets,
  filters,
  hiddenSummaryCards,
  includePriorityColumn = false,
  includeProjectColumn = false,
  includeTagsColumn = false,
  mode,
  now,
  onDateRangeChange,
  onFiltersChange,
  timezoneMode = DEFAULT_TIMEZONE_MODE,
  onTimezoneModeChange,
  onResetView,
  onToggleColumn,
  onToggleSummaryCard,
  rows,
  toggleableColumns,
  trailing,
  visibleColumns,
}: BranchesToolbarProps & {
  /** ISS-10332 @see BranchesPriorityColumnOptIn */
  includePriorityColumn?: BranchesPriorityColumnOptIn["includePriorityColumn"];
  /** ISS-12456 @see BranchesProjectColumnOptIn */
  includeProjectColumn?: BranchesProjectColumnOptIn["includeProjectColumn"];
  /** ISS-12456 @see BranchesTagsColumnOptIn */
  includeTagsColumn?: BranchesTagsColumnOptIn["includeTagsColumn"];
  /** The shared list surface's measured card/grid choice. */
  mode?: GridTableListSurfaceMode;
  /**
   * The live ordering and optional grouping. The shared Branches surface
   * supplies this at either flag state; direct callers may omit it.
   */
  columnControls?: BranchesColumnControls;
  /**
   * ISS-9317 — the column vocabulary the Sort and Group menus read, supplied by
   * the surface as DATA so the menus spell the `sessions` column the way the
   * header does. This toolbar reads no flag itself.
   */
  columnViewModel?: readonly ColumnViewModel[];
  /** The Columns picker's entries, for the same reason. Defaults to the approved set. */
  toggleableColumns?: readonly BranchesToggleableColumn[];
  /**
   * ISS-12663: the org's custom-field columns, offered in the Columns picker
   * after the built-in ones, as the Sessions list offers its own.
   */
  customFieldColumns?: Pick<
    BranchesCustomFieldColumns,
    "onAddField" | "toggleColumn" | "toggleOptions" | "visibleColumnIds"
  >;
}) {
  const declaredColumns =
    toggleableColumns ??
    (approved ? APPROVED_BRANCH_TOGGLEABLE_COLUMNS : BRANCH_TOGGLEABLE_COLUMNS);
  const columnsWithPriorityOptIn = includePriorityColumn
    ? declaredColumns
    : withoutBranchPriorityColumn(declaredColumns);
  const columnsWithTagsOptIn = includeTagsColumn
    ? columnsWithPriorityOptIn
    : withoutBranchTagsColumn(columnsWithPriorityOptIn);
  const columnDefinitions = includeProjectColumn
    ? columnsWithTagsOptIn
    : withoutBranchProjectColumn(columnsWithTagsOptIn);
  const viewModelWithPriorityOptIn = includePriorityColumn
    ? declaredColumnViewModel
    : withoutBranchPriorityColumn(declaredColumnViewModel);
  const viewModelWithTagsOptIn = includeTagsColumn
    ? viewModelWithPriorityOptIn
    : withoutBranchTagsColumn(viewModelWithPriorityOptIn);
  const columnViewModel = includeProjectColumn
    ? viewModelWithTagsOptIn
    : withoutBranchProjectColumn(viewModelWithTagsOptIn);
  const columns: readonly TableToggleOption[] = [
    ...columnDefinitions.map((column) => ({
      key: column.id,
      label: column.label,
    })),
    ...(customFieldColumns?.toggleOptions ?? []),
  ];
  const branchMetricLabel = useBranchMetricLabels();
  const summaryCardsConfigurable =
    onToggleSummaryCard !== undefined && hiddenSummaryCards !== undefined;
  const facetGroups = useBranchToolbarFacetGroups({
    approved,
    facets,
    filters,
    includePriorityColumn,
    includeTagsColumn,
    now,
    onFiltersChange,
    rows,
  });
  return (
    <ListSurfaceToolbarV2
      columns={columns}
      dateRange={dateRange}
      dateRangeOptions={TABLE_DATE_RANGE_OPTIONS}
      // `facetGroups` REPLACES the built-in assignee/status/priority categories,
      // so every other member of this controller is unreachable — the shared
      // no-op is what the v1 Branches toolbar and the Sessions surface pass for
      // the same reason.
      filterController={NOOP_TABLE_FILTERS_CONTROLLER}
      filterViewModel={buildFacetOnlyFiltersViewModel(
        // ISS-9676: which facets the popover offers is now the view model's
        // answer, not the builder's. It removes NOTHING today — the nine
        // approved facets are exactly the declared set — and that is the point:
        // it is the guard that catches a tenth facet arriving with no column to
        // justify it, which is the drift this ticket exists to close. Gated on
        // `approved` because the legacy builder speaks a different facet
        // vocabulary, and admitting THAT set against these columns would
        // withdraw filters rather than declare them.
        columnControls?.grouping && approved
          ? admitFilterableGroups(columnViewModel, facetGroups)
          : facetGroups
      )}
      leadingTrailing={
        onTimezoneModeChange === undefined ? null : (
          <TimezoneModeFilter
            onChange={onTimezoneModeChange}
            value={timezoneMode}
          />
        )
      }
      metrics={
        summaryCardsConfigurable
          ? branchesSummaryCardOptions(branchMetricLabel)
          : undefined
      }
      mode={mode}
      onAddField={customFieldColumns?.onAddField}
      onClearFilters={() => onFiltersChange(DEFAULT_BRANCH_FILTERS)}
      onDateRangeChange={(next) => onDateRangeChange(parseDateRange(next))}
      onToggleColumn={(columnId) => {
        if (isListCustomFieldColumnId(columnId)) {
          customFieldColumns?.toggleColumn(columnId);
          return;
        }
        toggleBranchColumn(columnId, onToggleColumn);
      }}
      onToggleMetric={
        summaryCardsConfigurable ? onToggleSummaryCard : undefined
      }
      optionsTrailing={
        onResetView ? <TableResetViewMenuItem onSelect={onResetView} /> : null
      }
      search={{
        onChange: (next) => onFiltersChange({ ...filters, search: next }),
        value: filters.search ?? "",
      }}
      sortGrouping={
        columnControls
          ? resolveBranchSortGrouping(columnControls, columnViewModel)
          : undefined
      }
      sortPlacement="compact"
      trailing={trailing}
      visibleColumnIds={customFieldColumns?.visibleColumnIds ?? visibleColumns}
      visibleMetricKeys={
        summaryCardsConfigurable
          ? resolveBranchesSummaryCardVisibility(hiddenSummaryCards)
              .visibleCardKeys
          : undefined
      }
    />
  );
}

/**
 * Report a toggled column by its OWN identifier rather than casting the menu's
 * `string` back to a `BranchColumnId`: the menu can only render the ids this
 * toolbar handed it, so the lookup both narrows the type and refuses an id that
 * is not a branch column.
 */
function toggleBranchColumn(
  columnId: string,
  onToggleColumn: (id: BranchColumnId) => void
): void {
  const column = [
    ...APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
    ...BRANCH_TOGGLEABLE_COLUMNS,
  ].find((candidate) => candidate.id === columnId);
  if (column) {
    onToggleColumn(column.id);
  }
}

/** The live ordering and grouping the shared sort/group cluster reads and writes. */
export type BranchesColumnControls = {
  /** Grouping stays absent while its closed-by-default flag is off. */
  grouping?: TableGroupingState;
  onGroupingChange?: (grouping: TableGroupingState) => void;
  /** Reinstate the list's default ordering, which is what "Clear" means here. */
  onResetSort: () => void;
  onSortChange: (sortKey: BranchListSortKey, direction: SortDirection) => void;
  sortDir: SortDirection;
  /** The persisted `BranchListSortKey`, widened because it is restored from storage. */
  sortKey: string;
};

/**
 * The shared sort arguments plus optional grouping arguments.
 *
 * `maxSortRules: 1` is the honest ceiling rather than the menu's default: the
 * Branches view state persists ONE key and one direction, so offering a second
 * clause would accept an ordering `sortBranchRows` never applies.
 */
function resolveBranchSortGrouping(
  columnControls: BranchesColumnControls,
  columnViewModel: readonly ColumnViewModel[]
): ListSurfaceSortGrouping {
  const applySortField = (fieldId: string, direction: SortDirection) => {
    const sortKey = branchSortKeyForColumn(fieldId);
    if (sortKey) {
      columnControls.onSortChange(sortKey, direction);
    }
  };
  const grouping =
    columnControls.grouping && columnControls.onGroupingChange
      ? {
          // Every grouping dimension is derived from the rendered rows, so
          // there is no outside empty band this surface can materialize.
          allowEmptyGroups: false,
          grouping: columnControls.grouping,
          groupOptions: groupableColumnOptions(columnViewModel),
          onGroupingChange: columnControls.onGroupingChange,
        }
      : {};
  return {
    ...grouping,
    maxSortRules: 1,
    onClearSort: columnControls.onResetSort,
    onSort: (fieldId: string, direction: SortDirection = "asc") =>
      applySortField(fieldId, direction),
    onSortsChange: (sorts: readonly TableSortRule[]) => {
      const [primary] = sorts;
      if (primary) {
        applySortField(primary.fieldId, primary.direction);
        return;
      }
      columnControls.onResetSort();
    },
    sortBy: resolveBranchSortColumnId(columnControls.sortKey),
    sortOptions: sortableColumnOptions(columnViewModel),
    sorts: branchSortRules(columnControls.sortKey, columnControls.sortDir),
  };
}

/** One Columns-picker entry: a branch column id and the label the menu shows for it. */
export type BranchesToggleableColumn = { id: BranchColumnId; label: string };
