// biome-ignore-all lint/a11y/useSemanticElements: The ARIA grid's trailing header cannot be a native th outside table markup.
"use client";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import {
  ProductGridTableV2,
  type ProductGridTableV2SelectionProps,
} from "@repo/app/shared/components/product-grid-table-v2";
import type { ProductGridTableV2CardCompatibility } from "@repo/app/shared/components/product-grid-table-v2-card-compatibility";
import { useGridValueAlignment } from "@repo/app/shared/feature-flags/use-grid-value-alignment";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Mode,
} from "@repo/design-system/components/ui/grid-table-v2";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import type { GridTableV2Props } from "@repo/design-system/lib/grid-table-v2-types";
import type { ReactNode } from "react";
import { AddFieldHeaderButton } from "../../../custom-fields/components/list-custom-field-controls";
import { SESSIONS_FOLD_FIT_SETTLE_MS } from "./session-detail-table";
import type { SessionsFavoriteController } from "./sessions-list-interactions";

export type SessionsGridHeaderActions = {
  getFilterContent: (columnId: string) => ReactNode;
  onGroup: (columnId: string) => void;
  onMove?: (
    columnId: string,
    direction: "start" | "left" | "right" | "end"
  ) => void;
};

export function SessionsListGridV2({
  columnOrder,
  columns,
  columnWidths,
  cardCompatibility,
  favorites,
  gridTemplateColumns,
  groupCollapse,
  groups,
  headerActions,
  interactionState,
  items,
  leadingColumnWidth,
  leadingSortKey,
  mode,
  onAddField,
  onColumnOrderChange,
  onColumnWidthChange,
  onLeadingColumnWidthChange,
  onGroupDrop,
  onSort,
  preferredActiveCellKey,
  renderAfterGroup,
  renderAfterRows,
  renderCell,
  renderLead,
  selection,
  showGroupCounts,
  sortBy,
  sortDir,
}: {
  columnOrder: readonly string[];
  cardCompatibility?: ProductGridTableV2CardCompatibility<SessionTableRow>;
  columns: readonly GridTableV2Column[];
  columnWidths: Readonly<Record<string, number>>;
  favorites?: SessionsFavoriteController;
  gridTemplateColumns: string;
  groupCollapse?: GridTableV2Props<SessionTableRow>["groupCollapse"];
  groups?: readonly GridTableV2Group<SessionTableRow>[];
  headerActions: SessionsGridHeaderActions;
  interactionState?: GridInteractionState;
  items: readonly SessionTableRow[];
  leadingColumnWidth: number;
  leadingSortKey?: string;
  mode: GridTableV2Mode;
  onAddField?: () => void;
  onColumnOrderChange?: (columnOrder: string[]) => void;
  onColumnWidthChange: (columnId: string, widthPx: number) => void;
  onLeadingColumnWidthChange: (widthPx: number) => void;
  onGroupDrop?: (
    row: SessionTableRow,
    group: GridTableV2Group<SessionTableRow>,
    subgroup?: GridTableV2Group<SessionTableRow>
  ) => void;
  onSort: (fieldId: string, direction: SortDirection) => void;
  /**
   * ISS-9555: where the roving tab stop should resume when the grid has no
   * remembered cell of its own. A KEY or nothing, never a flag — the surface
   * reads the focus-restoration gate at its own single read site and hands down
   * a value, so nothing here has a second opinion about whether the gate is
   * open. `GridTableV2` consults it after its own staleness test, so a key this
   * page does not paint falls through to the entry cell.
   *
   * Wide and narrow modes use the same roving grid path, so an identity-cell
   * key remains available across a responsive layout flip.
   */
  preferredActiveCellKey?: string;
  renderAfterGroup?: (group: GridTableV2Group<SessionTableRow>) => ReactNode;
  renderAfterRows?: ReactNode;
  renderCell: (columnId: string, row: SessionTableRow) => ReactNode;
  renderLead: GridTableV2Props<SessionTableRow>["renderLead"];
  /**
   * The host's selection, from `useListBulkSelection`. Absent, the host has no
   * selection model (ISS-9107/ISS-10528): rows carry no `aria-selected`, the
   * range drag and touch-selection paths stay unarmed.
   */
  selection?: ProductGridTableV2SelectionProps<SessionTableRow> &
    Pick<GridTableV2Props<SessionTableRow>, "onRenderedItemsChange">;
  showGroupCounts: boolean;
  sortBy: string | null;
  sortDir: SortDirection;
}) {
  const alignValuesToColumn = useGridValueAlignment();
  return (
    <ProductGridTableV2<SessionTableRow>
      alignValuesToColumn={alignValuesToColumn}
      cardCompatibility={cardCompatibility}
      columnOrder={columnOrder}
      columns={columns}
      columnWidths={columnWidths}
      // ISS-10245 retired `grid-table-v2-single-tab-stop` (ISS-8726),
      // `grid-table-v2-navigable-header-cells` (ISS-8930) and
      // `grid-table-v2-row-range-drag` (ISS-8747) ENABLED by operator ruling
      // (2026-09-14), so the APG single tab stop and the roving header cells
      // are what this grid always is.
      //
      // ISS-10528: the range drag is NOT, because it is the one of the three
      // that resolves into a SELECTION. A host with none resolves every
      // activation through `suppressRowSelection`, and that no-op is still
      // non-null, so the primitive's own `onRowRangeDrag != null` test cannot
      // tell it from a real handler.
      enableRowRangeDrag={selection?.enableRowRangeDrag}
      // No `leadingUtilityHeader`: a supplied node WINS over the labelled
      // fallback in `GridTableV2`, so the `aria-hidden` placeholder this used to
      // pass made `leadingUtilityLabel` inert and left the favorite
      // `columnheader` with no accessible name at all (davetho review). The
      // header is visually blank either way — omitting it lets `GridTableV2`
      // render its own `sr-only` cell carrying this label, which is what
      // `GenericArtifactTable` already does for the same track.
      favorite={
        favorites
          ? {
              favoriteIds: favorites.favoriteIds,
              getArtifactId: (row) => row.id,
              getItemLabel: (row) => row.name,
              isUnavailable: favorites.isUnavailable,
              onChange: favorites.onChange,
              pendingIds: favorites.pendingIds,
            }
          : undefined
      }
      // ISS-4906: hold the fitted template still through a continuous window
      // resize and re-fit once it stops, so the columns after the widened
      // identity track no longer step sideways at every fit threshold the drag
      // crosses. Shared with the legacy table so one number governs both.
      foldFitSettleMs={SESSIONS_FOLD_FIT_SETTLE_MS}
      getRowId={(row) => row.id}
      gridTemplateColumns={gridTemplateColumns}
      groupCollapse={groupCollapse}
      groups={groups ? [...groups] : undefined}
      headerActions={headerActions}
      interactionState={interactionState}
      // ISS-10528: gated on the same verdict as the range drag, one prop over
      // and for the same reason (marisolashgrove review). `GridTableV2` renders
      // `aria-selected={isRowSelected ? isRowSelected(item) : undefined}`, so a
      // SUPPLIED predicate makes every row carry `aria-selected="false"` — and
      // on a host with no selection model, that is a permanent claim in the
      // accessibility tree that no gesture on this surface can ever change. ISS-9574 named that exact shape. Withholding
      // the predicate DROPS the attribute rather than asserting a false value;
      // the primitive's other reads are all `isRowSelected?.(item)`, so the row
      // keeps its hover tint and carries no `data-state`.
      isRowSelected={selection?.isRowSelected}
      items={[...items]}
      leadingColumnWidth={leadingColumnWidth}
      leadingLabel="Session"
      leadingSortKey={leadingSortKey}
      leadingTooltip="The synced agent session name."
      mode={mode}
      navigableHeaderCells
      onColumnOrderChange={onColumnOrderChange}
      onColumnWidthChange={onColumnWidthChange}
      onGroupDrop={onGroupDrop}
      onLeadingColumnWidthChange={onLeadingColumnWidthChange}
      onRenderedItemsChange={selection?.onRenderedItemsChange}
      onRowClick={selection?.onRowClick ?? suppressRowSelection}
      onRowKeyboardNavigate={
        selection?.onRowKeyboardNavigate ?? suppressRowSelection
      }
      // ISS-8747: a drag reports rows the same way a click and a `Shift`-click
      // do, so all three land in `resolveGridRowSelection` through one handler
      // and the pointer cannot resolve a range the keyboard would not.
      onRowRangeDrag={selection?.onRowRangeDrag ?? suppressRowSelection}
      onRowSelectionToggle={selection?.onRowSelectionToggle}
      // ISS-13007: header select-all is intentionally absent; this preserves Cmd/Ctrl+A.
      onSelectAllRows={selection?.onSelectAllRows}
      onSort={onSort}
      // ISS-9659: unconditional. The `sessions-pinned-lead-column` gate was
      // retired ENABLED by operator ruling (2026-09-06) — the pin restored
      // intended behaviour rather than adding a feature — so both Sessions
      // hosts get it, and neither can pass it while the other forgets.
      pinLeadColumn
      preferredActiveCellKey={preferredActiveCellKey}
      renderAfterGroup={renderAfterGroup}
      renderAfterRows={renderAfterRows}
      renderCell={renderCell}
      renderLead={renderLead}
      renderLeadingUtilityInWide={favorites !== undefined}
      showGroupCounts={showGroupCounts}
      // ISS-4889: this table overflows its content area by ~1,000px, so the fold
      // is its normal state, not an edge case; snapping it to a whole column is
      // what makes the ISS-4788 invariant structural rather than a function of
      // column order. Retiring the desktop v1 host (ISS-8909) dropped this with
      // the table that used to carry it, which is why it is wired here.
      snapFoldToColumns
      sortBy={sortBy}
      sortDir={sortDir}
      suppressCellTabStops
      // The FUNCTION form, so Add field joins the header's roving walk instead
      // of keeping a tab stop the grid cannot see (whitlockk review). With
      // `navigableHeaderCells` unconditional (ISS-10245) the primitive always
      // supplies the roving wiring to this slot.
      trailingHeader={
        onAddField
          ? (cellProps) => (
              <AddFieldHeaderButton
                columnIndex={columns.length + (favorites ? 3 : 2)}
                navigationProps={cellProps}
                onClick={onAddField}
              />
            )
          : undefined
      }
      // ISS-12288: a page may hold up to 500 rows (`TABLE_PAGE_SIZE_MAX`) and
      // every poll and focus refetch re-ran the row adapters over all of them.
      // Wired here rather than per host so one shell cannot have the window
      // while the other does not; the primitive declines it itself on a grouped
      // body, whose rows are not all one height.
      virtualizeRows
    />
  );
}

/**
 * A host with no selection model still routes row activations here: clicks keep
 * reaching the lead cell's link, and only the selection they would otherwise
 * accumulate is dropped (ISS-9107).
 */
function suppressRowSelection(): void {
  // no-op
}
