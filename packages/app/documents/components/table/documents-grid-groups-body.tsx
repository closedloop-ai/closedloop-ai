"use client";

import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  DocumentCellFrame,
  DocumentCellFrameContext,
} from "@repo/app/documents/components/table/cells/cell-frame";
import { CELL_RENDERERS } from "@repo/app/documents/components/table/cells/cell-renderers";
import { NameCell } from "@repo/app/documents/components/table/cells/name-cell";
import {
  buildRankSlot,
  RANK_DRAG_HANDLE_CLASS,
} from "@repo/app/documents/components/table/cells/rank-slot";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  DocumentCard,
  getDocumentRowGridTemplateColumns,
  useDocumentRowHref,
} from "@repo/app/documents/components/table/document-row";
import {
  manualHandleLabel,
  placementDirection,
} from "@repo/app/documents/components/table/documents-ungrouped-tree-body";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import type { RankInteractionMode } from "@repo/app/documents/components/table/sort-keys";
import { shouldShowRankSlot } from "@repo/app/documents/components/table/sort-keys";
import {
  type DocumentRowSelectionChange,
  routeRowSelectionChange,
} from "@repo/app/documents/hooks/use-documents-legacy-row-selection";
import {
  collectPaintedDocumentGroupRows,
  getDocumentRowChildren,
  getDocumentRowId,
} from "@repo/app/documents/lib/documents-grid-groups";
import { ProductGridTableV2 } from "@repo/app/shared/components/product-grid-table-v2";
import {
  ARTIFACT_COLUMN_LABELS,
  type DocumentColumn,
  NON_SORTABLE_COLUMNS,
} from "@repo/app/shared/hooks/use-column-visibility";
import { hierarchyAvailabilityState } from "@repo/app/shared/lib/hierarchy-availability-state";
import type { HierarchyPlacementDirection } from "@repo/app/shared/lib/hierarchy-placement";
import {
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { getTableCellPrimitiveStateValue } from "@repo/design-system/components/ui/table-cell-primitives";
import type { TableGridHeaderV2SortOption } from "@repo/design-system/components/ui/table-grid-header-v2";
import { useGridRowSelection } from "@repo/design-system/hooks/use-grid-row-selection";
import {
  type GridSelectionModifiers,
  gridTableV2SelectionProps,
} from "@repo/design-system/lib/grid-table-v2-selection";
import {
  createSiblingFlattener,
  FIRST_TREE_LEVEL,
} from "@repo/design-system/lib/grid-table-v2-tree";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2LeadContext,
} from "@repo/design-system/lib/grid-table-v2-types";
import { GripVerticalIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

/**
 * What the row disclosure is called, in the board's own nouns rather than the
 * grid's generic "Expand row". A board row IS an artifact and what opens under
 * it is the artifacts nested beneath it, which is what a reader needs to hear
 * before deciding to press it.
 */
const EXPAND_ROW_LABEL = "Show nested artifacts";
const COLLAPSE_ROW_LABEL = "Hide nested artifacts";
/** What the lead header calls itself. */
const LEAD_COLUMN_LABEL = "Name";

export type DocumentsGridGroupsBodyProps = {
  /** Canonical bands with domain cells supplied by the owning Documents view. */
  groups?: GridTableV2Group<DocumentRowItem>[];
  /** Root rows for an ungrouped hierarchy. */
  items?: DocumentRowItem[];
  visibleColumns: DocumentColumn[];
  /**
   * Whether rows carry a subtree. The "All" projection nests artifacts under
   * their root; the flat category tabs do not, and passing a child accessor
   * there would make a flat list declare itself a `treegrid`.
   */
  isNested: boolean;
  editHandlers?: RowEditHandlers;
  parentMap: ReadonlyMap<string, { title: string; href: string | null }>;
  selectedIds: ReadonlySet<string>;
  showCheckbox: boolean;
  selectMode: boolean;
  onSelectionChange: (id: string, checked: boolean) => void;
  /** Commits an exact hierarchy placement on another row. */
  onRowDrop?: (
    item: DocumentRowItem,
    target: DocumentRowItem,
    placement: "before" | "inside" | "after"
  ) => void;
  /** Narrows exact row placements before the grid paints a valid target. */
  canDropOnRow?: (
    item: DocumentRowItem,
    target: DocumentRowItem,
    placement: "before" | "inside" | "after"
  ) => boolean;
  /** Restricts native row drag to hierarchy-supported artifact kinds. */
  canDragRow?: (item: DocumentRowItem) => boolean;
  onKeyboardPlacement?: (
    rowId: string,
    direction: HierarchyPlacementDirection
  ) => void;
  /** The row's own overflow ("More actions") menu, built by the owning view. */
  renderRowActions: (item: DocumentRowItem) => ReactNode;
  sortBy: string | null;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
  /**
   * The lead column's sort keys, as the board's header has always offered them
   * (Name / Status / ID). Each item cycles asc -> desc -> clear, so
   * `onClearSort` is the third press of the same item rather than a control of
   * its own.
   */
  leadingSortOptions: readonly TableGridHeaderV2SortOption[];
  onClearSort: () => void;
  /**
   * Select-all, in the lead header cell beside the column label — the same
   * place the board's own header puts it, and mirroring the row checkbox that
   * sits beside each row's identity. `allSelected` / `someSelected` drive its
   * tri-state.
   */
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onRenderedItemsChange?: (items: readonly DocumentRowItem[]) => void;
  /**
   * Reorder the DATA columns (FEA-4165). Omit and the headers grow no drag
   * handle, exactly as the board's own header does for a caller that passes no
   * reorder callback.
   */
  onReorderColumns?: (nextVisibleOrder: string[]) => void;
  /**
   * Stack-rank interaction state (PRD-421). A grouped board is always
   * `DisabledGrouped`, which renders the greyed handle and its "Disable
   * grouping to reorder" tooltip — the affordance that tells a reader WHY the
   * drag they expect is absent, which a body that simply omitted the slot would
   * not.
   */
  rankInteractionMode?: RankInteractionMode;
  /**
   * Band collapse, owned by the view so it survives navigation — the board
   * persists it per surface. Subgroup keys never reach this: the board has one
   * grouping level.
   */
  groupCollapse?: {
    isCollapsed: (groupKey: string) => boolean;
    setCollapsed: (groupKey: string, collapsed: boolean) => void;
  };
  /**
   * Row expansion, owned by the view for the same reason plus one the grid's
   * own seed cannot serve: an active filter force-opens the ancestors of a
   * matching descendant while the reader types.
   */
  rowExpansion: {
    isExpanded: (rowId: string) => boolean;
    setExpanded: (rowId: string, expanded: boolean) => void;
  };
};

/**
 * Canonical document bands compose root-owned lineage with the shared grid's
 * headers, keyboard model and responsive narrow rows. Cells retain the same domain
 * editors and navigation as the ungrouped document rows.
 */
export function DocumentsGridGroupsBody({
  allSelected,
  canDragRow,
  canDropOnRow,
  editHandlers,
  groupCollapse,
  groups,
  items = NO_UNGROUPED_ITEMS,
  isNested,
  leadingSortOptions,
  onClearSort,
  onReorderColumns,
  onRowDrop,
  onKeyboardPlacement,
  onRenderedItemsChange,
  onSelectAll,
  onSelectionChange,
  onSort,
  parentMap,
  rankInteractionMode,
  renderRowActions,
  rowExpansion,
  selectedIds,
  selectMode,
  showCheckbox,
  someSelected,
  sortBy,
  sortDir,
  visibleColumns,
}: DocumentsGridGroupsBodyProps) {
  const resolveHref = useDocumentRowHref();
  const selectionRows = useMemo(
    () =>
      flattenSelectionRows(groups?.flatMap((group) => group.items) ?? items),
    [groups, items]
  );
  const selection = useGridRowSelection<SelectionRow>({
    controller: {
      onChange: (next) => {
        for (const id of selectedIds) {
          if (!next.has(id)) {
            onSelectionChange(id, false);
          }
        }
        for (const id of next) {
          if (!selectedIds.has(id)) {
            onSelectionChange(id, true);
          }
        }
      },
      selectedIds,
    },
    visibleRowIds: selectionRows.map((item) => item.data.id),
  });
  const selectionProps = gridTableV2SelectionProps<SelectionRow>({
    getCardLabel: (row) => itemLabel(row.item),
    isRowSelected: (row) => selectedIds.has(row.id),
    onRowSelection: selection.onRowSelection,
    onRowSelectionToggle: selection.toggleRowSelection,
    onSelectAllRows: selection.selectAllRows,
  });
  const paintedRowsById = useMemo(() => {
    const rows = groups
      ? collectPaintedDocumentGroupRows({
          gridGroups: groups,
          isGroupExpanded: rowExpansion.isExpanded,
          isNested,
          isSectionExpanded: (key) => !groupCollapse?.isCollapsed(key),
        })
      : createSiblingFlattener({
          expandedRowIds: { has: rowExpansion.isExpanded },
          getChildren: getDocumentRowChildren,
          getRowId: getDocumentRowId,
        })(items);
    return new Map(rows.map((row) => [row.rowId, row]));
  }, [groupCollapse, groups, isNested, items, rowExpansion]);
  const onNameCellSelectionChange = useNameCellSelectionChange({
    paintedRowIds: paintedRowsById,
    selection,
    selectedIds,
    selectionRows,
  });
  const columns: GridTableV2Column[] = [
    ...visibleColumns.map((column) => ({
      id: column,
      label: ARTIFACT_COLUMN_LABELS[column],
      // The same set the board's own header reads. A `Tags` header that drew a
      // sort arrow would be lying twice over: there is no `SortKey` member for
      // it, so `useSortParams` rejects the write and the click does nothing.
      sortable: !NON_SORTABLE_COLUMNS.has(column),
    })),
    // The shared spec, not a fourth spelling of the id, the blank label and the
    // name — `ROW_ACTIONS_COLUMN`'s docstring owns why the name is "Actions".
    ROW_ACTIONS_COLUMN,
  ];

  // The row's edit ports and its parent context, as the cells read them. In the
  // bespoke row one provider wraps the whole row; a grid owns its row element,
  // so the provider wraps each CELL instead — the same value, reaching the same
  // consumers, through markup the host is allowed to place.
  const renderWithRowContext = (
    item: DocumentRowItem,
    children: ReactNode
  ): ReactNode => (
    <RowEditContext.Provider
      value={{
        ...(isDocumentRowItem(item) ? editHandlers : {}),
        parentHref: parentMap.get(item.data.id)?.href,
        parentTitle: parentMap.get(item.data.id)?.title,
      }}
    >
      {children}
    </RowEditContext.Provider>
  );

  const renderCell = (columnId: string, item: DocumentRowItem): ReactNode => {
    if (columnId === ROW_ACTIONS_COLUMN_ID) {
      // Bare, with no wrapper: `GridTableV2Cell` already IS the bordered,
      // padded, full-height flex box the ungrouped document row draws for itself.
      return rowAffordances(item);
    }
    const CellRenderer = CELL_RENDERERS[columnId as DocumentColumn];
    if (!CellRenderer) {
      return null;
    }
    // The grid cell is this value's frame.
    return renderWithRowContext(
      item,
      <DocumentCellFrameContext.Provider value={DocumentCellFrame.Host}>
        <CellRenderer item={item} />
      </DocumentCellFrameContext.Provider>
    );
  };

  // The identity cluster rendered by the grid's lead cell.
  // No chevron and no indent from the name cell: inside a treegrid the grid's
  // own `GridTableV2TreeLead` renders both, and a second disclosure would state
  // one row's open/closed state twice.
  const renderNameCell = (
    item: DocumentRowItem,
    { isNarrowList }: GridTableV2LeadContext
  ): ReactNode => {
    const row = paintedRowsById.get(item.data.id);
    const isRoot = row?.tree === null || row?.tree?.level === FIRST_TREE_LEVEL;
    // ISS-12893 AC3: only Document rows take hierarchy placement; every other
    // kind keeps the slot's width so lineage indentation still lines up.
    const placementExcluded = Boolean(onRowDrop) && !isDocumentRowItem(item);
    const rowRankInteractionMode =
      !placementExcluded && (onRowDrop || isRoot)
        ? rankInteractionMode
        : undefined;
    const placementHandle =
      onRowDrop && !placementExcluded ? (
        <button
          aria-label={manualHandleLabel(item)}
          className={RANK_DRAG_HANDLE_CLASS}
          data-grid-row-drag-handle=""
          onKeyDown={(event) => {
            const direction = placementDirection(event);
            if (direction) {
              event.preventDefault();
              onKeyboardPlacement?.(item.data.id, direction);
            }
          }}
          type="button"
        >
          <GripVerticalIcon className="h-4 w-4" />
        </button>
      ) : undefined;
    const name = (
      <NameCell
        // The grid's lead cell already pads the track; the name cell's own
        // padding would double the gutters and push the first glyph off the
        // indent rhythm the disclosure beside it sets. ISS-11412: that padding is
        // `pl-4` while the header opens its select-all slot at `pl-3`, so a
        // selectable row pulls its slot back by the difference to sit under it.
        className={showCheckbox ? "-ml-1 px-0" : "px-0"}
        href={resolveHref(item)}
        isSelected={selectedIds.has(item.data.id)}
        item={item}
        narrow={isNarrowList}
        onSelectionChange={onNameCellSelectionChange}
        rankSlot={buildRankSlot(
          rowRankInteractionMode,
          placementHandle,
          shouldShowRankSlot(rankInteractionMode) &&
            (placementExcluded || !(onRowDrop || isRoot))
        )}
        selectMode={selectMode}
        showCheckbox={showCheckbox && !isNarrowList}
      />
    );
    const lead = (
      <div
        className={
          isNarrowList
            ? "flex min-w-0 flex-1 items-center gap-2"
            : "flex min-w-0 items-center gap-2"
        }
      >
        {name}
        {getTableCellPrimitiveStateValue({
          state:
            hierarchyAvailabilityState(item.hierarchy?.availability) ??
            undefined,
        })}
      </div>
    );
    return isNarrowList ? (
      <div className="flex min-w-0 items-center gap-1">
        {lead}
        <div className="flex shrink-0 items-center">{rowAffordances(item)}</div>
      </div>
    ) : (
      lead
    );
  };

  // The row's trailing affordances stay in the wide actions column.
  const rowAffordances = (item: DocumentRowItem): ReactNode => (
    <>
      {item.kind === "project" ? null : (
        <FavoriteButton artifactId={item.data.id} size="sm" />
      )}
      {renderRowActions(item)}
    </>
  );
  // The canonical hierarchy is an ordered treegrid until PR #8962 supplies its
  // one-column list. Flattening it into root-only cards would hide lineage.
  const renderCards = groups !== undefined || !isNested;
  const gridCanDragRow = onRowDrop
    ? (item: DocumentRowItem) =>
        isDocumentRowItem(item) && (canDragRow?.(item) ?? true)
    : canDragRow;
  const gridCanDropOnRow = onRowDrop
    ? (
        item: DocumentRowItem,
        target: DocumentRowItem,
        placement: "before" | "inside" | "after"
      ) =>
        isDocumentRowItem(item) &&
        isDocumentRowItem(target) &&
        (canDropOnRow?.(item, target, placement) ?? true)
    : canDropOnRow;
  const gridOnRowDrop = onRowDrop
    ? (
        item: DocumentRowItem,
        target: DocumentRowItem,
        placement: "before" | "inside" | "after"
      ) => {
        if (isDocumentRowItem(item) && isDocumentRowItem(target)) {
          onRowDrop(item, target, placement);
        }
      }
    : undefined;

  return (
    <ProductGridTableV2<DocumentRowItem>
      allSelected={allSelected}
      canDragRow={gridCanDragRow}
      canDropOnRow={gridCanDropOnRow}
      cardCompatibility={
        renderCards
          ? {
              render: (item) =>
                renderWithRowContext(
                  item,
                  <DocumentCard
                    isSelected={selectedIds.has(item.data.id)}
                    item={item}
                    moreMenu={rowAffordances(item)}
                    nameCell={renderNameCell(item, { isNarrowList: false })}
                    visibleColumns={visibleColumns}
                  />
                ),
            }
          : undefined
      }
      collapseRowLabel={COLLAPSE_ROW_LABEL}
      columnOrder={visibleColumns}
      columns={columns}
      expandRowLabel={EXPAND_ROW_LABEL}
      getCardSelectionLabel={(item, selected) =>
        selectionProps.getCardSelectionLabel?.(selectionRow(item), selected) ??
        itemLabel(item)
      }
      getChildren={isNested ? getDocumentRowChildren : undefined}
      getRowId={getDocumentRowId}
      gridTemplateColumns={getDocumentRowGridTemplateColumns(
        visibleColumns.length
      )}
      groupCollapse={groupCollapse}
      groups={groups && groups.length > 0 ? groups : undefined}
      isRowSelected={(item) => selectedIds.has(item.data.id)}
      items={items}
      leadingLabel={LEAD_COLUMN_LABEL}
      leadingSortOptions={leadingSortOptions}
      // The trailing actions track is fixed: it is where the row's own controls
      // live, not a data column, so it holds its slot in the order without
      // growing a drag handle of its own.
      movableColumnIds={visibleColumns}
      onClearSort={onClearSort}
      onColumnOrderChange={onReorderColumns}
      onRenderedItemsChange={onRenderedItemsChange}
      onRowClick={(item, event, renderedItems) =>
        selectionProps.onRowClick?.(
          selectionRow(item),
          event,
          renderedItems.map(selectionRow)
        )
      }
      onRowDrop={gridOnRowDrop}
      onRowKeyboardNavigate={(item, event, renderedItems) =>
        selectionProps.onRowKeyboardNavigate?.(
          selectionRow(item),
          event,
          renderedItems.map(selectionRow)
        )
      }
      onRowSelectionToggle={(item) =>
        showCheckbox
          ? selectionProps.onRowSelectionToggle?.(selectionRow(item))
          : undefined
      }
      onSelectAll={onSelectAll}
      // `Ctrl/Cmd+A` routes to the SAME handler as the header checkbox, so both
      // select the painted rows (collapsed bands excluded, ISS-12640 AC-3) from
      // the one population the header's checked state also reads.
      onSelectAllRows={showCheckbox ? () => onSelectAll(true) : undefined}
      onSort={onSort}
      renderCell={renderCell}
      renderLead={(item, context) =>
        renderWithRowContext(item, renderNameCell(item, context))
      }
      rowDragPreviewLabel={onRowDrop ? itemLabel : undefined}
      rowExpansion={rowExpansion}
      showSelectAll={showCheckbox}
      someSelected={someSelected}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

/** `items` is ignored in grouped mode; the bands carry every row. */
const NO_UNGROUPED_ITEMS: DocumentRowItem[] = [];

function flattenSelectionRows(
  roots: readonly DocumentRowItem[]
): DocumentRowItem[] {
  const rows: DocumentRowItem[] = [];
  const pending = [...roots].reverse();
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) {
      continue;
    }
    rows.push(row);
    pending.push(
      ...(Array.isArray(row.children) ? [...row.children].reverse() : [])
    );
  }
  return rows;
}

function itemLabel(item: DocumentRowItem): string {
  return item.kind === "document" ? item.data.title : item.data.name;
}

type SelectionRow = { id: string; item: DocumentRowItem };

function selectionRow(item: DocumentRowItem): SelectionRow {
  return { id: item.data.id, item };
}

/**
 * The name cell's own checkbox, routed through the grid's shared selection so
 * a Shift or Cmd/Ctrl click there means what it means on the row (PRD-718 AC4).
 * A range spans the painted rows in painted order.
 */
function useNameCellSelectionChange({
  paintedRowIds,
  selection,
  selectedIds,
  selectionRows,
}: {
  paintedRowIds: ReadonlyMap<string, unknown>;
  selection: {
    onRowSelection: (
      row: SelectionRow,
      modifiers: GridSelectionModifiers,
      renderedRows?: readonly SelectionRow[]
    ) => void;
    toggleRowSelection: (row: SelectionRow) => void;
  };
  selectedIds: ReadonlySet<string>;
  selectionRows: readonly DocumentRowItem[];
}): DocumentRowSelectionChange {
  const { onRowSelection, toggleRowSelection } = selection;
  const rowsById = useMemo(
    () =>
      new Map(selectionRows.map((item) => [item.data.id, selectionRow(item)])),
    [selectionRows]
  );
  const renderedRows = useMemo(
    () =>
      [...paintedRowIds.keys()].flatMap((id) => {
        const row = rowsById.get(id);
        return row ? [row] : [];
      }),
    [paintedRowIds, rowsById]
  );
  return useCallback<DocumentRowSelectionChange>(
    (id, checked, modifiers) => {
      const row = rowsById.get(id);
      if (!row) {
        return;
      }
      routeRowSelectionChange({
        checked,
        isSelected: selectedIds.has(id),
        modifiers,
        onRowSelection,
        renderedRows,
        row,
        toggleRowSelection,
      });
    },
    [onRowSelection, renderedRows, rowsById, selectedIds, toggleRowSelection]
  );
}
