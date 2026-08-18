"use client";

import type { ReadSource } from "@repo/api/src/types/read-source";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import {
  type SavedViewOption,
  TableSavedViewsSwitcher,
} from "@repo/design-system/components/ui/table-saved-views-switcher";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import type { ReactNode } from "react";
import { DateRangeFilter } from "../../shared/components/date-range-filter";
import { ReadSourceBadge } from "../../shared/components/read-source-badge";
import { NOOP_TABLE_FILTERS_CONTROLLER } from "../../shared/lib/facet-filter";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
  BRANCH_TOGGLEABLE_COLUMNS,
  type BranchColumnId,
} from "../hooks/use-branch-view-state";
import {
  branchFilterFacetGroups,
  legacyBranchFilterFacetGroups,
} from "../lib/branch-filter-adapter";
import type { BranchFilters, BranchRow } from "../lib/branch-row";

export type BranchesToolbarProps = {
  filters: BranchFilters;
  onFiltersChange: (next: BranchFilters) => void;
  rows: BranchRow[];
  /** First-class time window — drives the list query AND the summary metrics. */
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  visibleColumns: Set<string>;
  onToggleColumn: (id: BranchColumnId) => void;
  /**
   * FEA-4021: restore every column to visible AND to its natural order. Wired to
   * the view state's `resetColumns`. Anything the table persists on the user's
   * behalf (hidden columns, a dragged column order) needs a one-click way back.
   */
  onResetView?: () => void;
  /**
   * FEA-3120 / PLN-1138: which store the current branch rows were read from,
   * rendered as a small `Local`/`Cloud`/`Fallback` badge so a user (and QA) can
   * tell a data bug from a sync gap — and see the authenticated-offline
   * degradation. Undefined ⇒ no badge (unknown source).
   */
  readSource?: ReadSource;
  /**
   * ISS-5477: the sentence explaining WHY that source is in play right now.
   * Passed through rather than derived here because the explanation is
   * desktop-only (it reads the desktop sync/import backlog) while this toolbar
   * is shared with the web app, which has no such backlog.
   */
  readSourceDetail?: string;
  /** ISS-5477: this read is known to be short — see `ReadSourceBadge`. */
  readSourceIncomplete?: boolean;
  /**
   * FEA-4180: named saved views. When provided, a view switcher renders at the
   * left of the toolbar (create / rename / switch / delete a named arrangement
   * — column order + visibility + sort + filters). Omit to hide the switcher
   * (surfaces without saved-view persistence). Wired to `useBranchSavedViews`.
   */
  savedViews?: BranchesToolbarSavedViews;
  /** Extra actions render after the built-in controls. */
  trailing?: ReactNode;
  /** Complete PRD-601 controls, selected by the default-off host flag. */
  approved?: boolean;
};

export type BranchesToolbarSavedViews = {
  views: readonly SavedViewOption[];
  activeViewId: string | null;
  /** Whether the live table has diverged from the active view (FEA-4180). */
  modified: boolean;
  onSelectView: (id: string | null) => void;
  onCreateView: (name: string) => void;
  onUpdateView: (id: string) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
};

/**
 * Branches toolbar — a left-aligned time-window + "Filter" + "View" cluster
 * shared by the web `/branches` page and the desktop Branches view. The time
 * window (`DateRangeFilter`) is first-class so it stays visible; "Filter" is the
 * generic `FilterPopover` (Status/Repository facets); "View" is the generic
 * `TableViewMenu` (Show/Hide Columns). Sorting is driven by clickable column
 * headers in `BranchesTable`. View state lives in `useBranchViewState`; filter
 * state in `useBranchFilterState`. When `savedViews` is supplied (FEA-4180), a
 * named-view switcher (`TableSavedViewsSwitcher`, from `useBranchSavedViews`)
 * leads the cluster so a user can save / rename / switch / delete a named
 * arrangement (order + visibility + sort + filters).
 */
export function BranchesToolbar({
  filters,
  onFiltersChange,
  rows,
  dateRange,
  onDateRangeChange,
  visibleColumns,
  onToggleColumn,
  onResetView,
  readSource,
  readSourceDetail,
  readSourceIncomplete,
  savedViews,
  trailing,
  approved = false,
}: BranchesToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {savedViews ? (
        <TableSavedViewsSwitcher
          activeViewId={savedViews.activeViewId}
          modified={savedViews.modified}
          onCreateView={savedViews.onCreateView}
          onDeleteView={savedViews.onDeleteView}
          onRenameView={savedViews.onRenameView}
          onSelectView={savedViews.onSelectView}
          onUpdateView={savedViews.onUpdateView}
          triggerLabel="Branch views"
          views={savedViews.views}
        />
      ) : null}

      <DateRangeFilter onChange={onDateRangeChange} value={dateRange} />

      <FilterPopover
        controller={NOOP_TABLE_FILTERS_CONTROLLER}
        viewModel={{
          teamMembers: [],
          statusOptions: [],
          priorityOptions: [],
          hideQuickToggles: true,
          facetGroups: approved
            ? branchFilterFacetGroups(rows, filters, onFiltersChange)
            : legacyBranchFilterFacetGroups(rows, filters, onFiltersChange),
        }}
      />

      <TableViewMenu
        align="start"
        columns={(approved
          ? APPROVED_BRANCH_TOGGLEABLE_COLUMNS
          : BRANCH_TOGGLEABLE_COLUMNS
        ).map((column) => ({
          id: column.id,
          label: column.label,
          visible: visibleColumns.has(column.id),
        }))}
        // "Columns", not "View": the saved-views switcher ("Branch views" →
        // "Views: …") already owns the view-identity concept, so this menu reads
        // as what it actually does — show/hide columns — instead of a second
        // "view" control beside it.
        label="Columns"
        onResetView={onResetView}
        onToggleColumn={(id) => onToggleColumn(id as BranchColumnId)}
        resetLabel={approved ? "Reset columns" : undefined}
      />

      <ReadSourceBadge
        detail={readSourceDetail}
        incomplete={readSourceIncomplete}
        readSource={readSource}
        surfaceLabel="branches"
      />

      {trailing}
    </div>
  );
}
