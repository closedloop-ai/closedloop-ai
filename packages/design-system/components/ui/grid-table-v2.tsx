// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Preserve the approved Generic Artifact prototype keyboard behavior in this v2 component.
// biome-ignore-all lint/a11y/noStaticElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: Keyboard navigation is handled by the prototype's cell-level handlers.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the approved Generic Artifact prototype behavior in this v2 component.
// biome-ignore-all lint/style/noNestedTernary: Preserve the approved Generic Artifact prototype render branches in this v2 component.
"use client";

import { useContainerWidth } from "@closedloop-ai/design-system/hooks/use-container-width";
import { useMediaQuery } from "@closedloop-ai/design-system/hooks/use-media-query";
import { useGridCellTabStops } from "@closedloop-ai/design-system/hooks/use-grid-cell-tab-stops";
import { useGridTableV2TouchSelection } from "@closedloop-ai/design-system/hooks/use-grid-table-v2-touch-selection";
import { useSettledValue } from "@closedloop-ai/design-system/hooks/use-settled-value";
import { hideNativeDragImage } from "@closedloop-ai/design-system/lib/grid-row-drag-image";
import { resolveGridTableV2ColumnControls } from "@closedloop-ai/design-system/lib/grid-table-v2-column-controls";
import { GRID_TABLE_V2_NARROW_LEADING_LABEL } from "@closedloop-ai/design-system/lib/grid-table-v2-constants";
import {
  type GridSelectionHandlers,
  handleGridCellKeyDown,
} from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import {
  AFTER_ROWS_ROW_ID,
  buildAfterGroupRowId,
  buildAfterItemRowId,
  buildAfterRowCellKeys,
  buildFirstCellKey,
  type GridCellNavigationProps,
  GridTableAfterRowProvider,
  resolveAfterRows,
} from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import {
  buildAfterRowCellKey,
  buildChromeCellKey,
  collectCollapsedGroupKeys,
  collectRenderedCellKeys,
  collectRenderedGroupRows,
  LEAD_CELL_COLUMN_KEY,
  nextCollapsedGroupKeys,
  UTILITY_CELL_COLUMN_KEY,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import {
  buildGroupHeaderRowId,
  buildHeaderCellColumnKeys,
  collectGroupHeaderRowIds,
  type GridChromeCellProps,
  GROUP_HEADER_COLUMN_KEY,
  HEADER_ROW_ID,
  TRAILING_HEADER_COLUMN_KEY,
} from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import {
  createGroupDropHandlers,
  GRID_ROW_DRAG_TYPE,
  startGridRowDrag,
} from "@closedloop-ai/design-system/lib/grid-table-v2-group-drop";
import {
  ROW_DRAG_ANCHOR_MODIFIERS,
  ROW_DRAG_EXTEND_MODIFIERS,
} from "@closedloop-ai/design-system/lib/grid-table-v2-row-drag";
import type { GridSelectionModifiers } from "@closedloop-ai/design-system/lib/grid-table-v2-selection";
import {
  findGridTableV2Row,
  GRID_TABLE_V2_NARROW_VIEWPORT_QUERY,
  hasSelectedGridTableV2Row,
  resolveGridTableV2Layout,
} from "@closedloop-ai/design-system/lib/grid-table-v2-responsive";
import { useAltKeyHeld } from "@closedloop-ai/design-system/hooks/use-alt-key-held";
import { useGridRowRangeDrag } from "@closedloop-ai/design-system/hooks/use-grid-row-range-drag";
import { useGridRenderedItemsChange } from "@closedloop-ai/design-system/hooks/use-grid-rendered-items-change";
import { useGridRowWindow } from "@closedloop-ai/design-system/hooks/use-grid-row-window";
import { useGridWindowedRowNavigation } from "@closedloop-ai/design-system/hooks/use-grid-windowed-row-navigation";
import {
  collectPaintedRows,
  resolveGridRowPaintPlan,
} from "@closedloop-ai/design-system/lib/grid-row-window";
import { isInteractiveRowClickTarget } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import {
  createSiblingFlattener,
  type ExpandedRowLookup,
  type GridRenderRow,
  nextExpandedRowIds,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import { createGridRowExpansionCommands } from "@closedloop-ai/design-system/lib/grid-table-v2-expansion-commands";
import type { GridTableV2Props } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import {
  type DragEvent,
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { DragPreviewChip, type DragPreviewChipProps } from "./drag-preview-chip";
import { GridTableV2Cell } from "./grid-table-v2-cell";
import { GridTableV2Frame } from "./grid-table-v2-frame";
import { renderGridTableV2GroupedRows } from "./grid-table-v2-grouped-rows";
import { renderGridTableV2Row } from "./grid-table-v2-row";
import { renderGridTableV2WindowedRows } from "./grid-table-v2-windowed-rows";
import {
  createGridTableV2CardRenderer,
  GridTableV2CardList,
  isGridTableV2CardMode,
} from "./grid-table-v2-card-list";
import { TableGridHeaderV2 } from "./table-grid-header-v2";
import { GRID_NAV_TABLE_ROLE } from "./grid-table-v2-cell";

export { GridEmptyValue, isEmptyCellValue } from "./grid-table-card";
export {
  buildGridTableV2CardFields,
  GridTableV2Card,
  type GridTableV2CardField,
} from "./grid-table-v2-card";
export { GridTableV2Cell } from "./grid-table-v2-cell";
export {
  GRID_TABLE_V2_ADD_FIELD_TRACK,
  GRID_TABLE_V2_FAVORITE_TRACK,
  GRID_TABLE_V2_NARROW_LEADING_LABEL,
} from "@closedloop-ai/design-system/lib/grid-table-v2-constants";
export type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Mode,
} from "@closedloop-ai/design-system/lib/grid-table-v2-types";

/**
 * Data-agnostic shared grid for web and Desktop. Callers own row data, tracks,
 * cells, sorting, and optional column controls; the host owns overflow.
 *
 * Responsive narrow list (PRD-727): the table follows the viewport width and
 * projects this same grid to its identity column below the existing narrow
 * breakpoint. `expanded` forces every column and `compact` forces the one-column
 * list. Grouping, hierarchy, selection, focus, and keyboard behavior therefore
 * stay on the canonical row path instead of moving into a second renderer.
 *
 * `getChildren` opts into the same rows as a WAI-ARIA treegrid with disclosure
 * state and arrow-key expansion; without it, the component remains a flat grid.
 */
export function GridTableV2<T>({
  staticTableSemantics = false,
  items,
  getRowId,
  columns,
  gridTemplateColumns,
  leadingLabel,
  leadingTooltip,
  leadingColumnWidth,
  onLeadingColumnWidthChange,
  renderLead,
  cardRender,
  getCardSelectionLabel,
  renderLeadingUtility,
  renderNarrowTrailingAction,
  renderLeadingUtilityInWide = true,
  leadingUtilityHeader,
  leadingUtilityLabel = DEFAULT_LEADING_UTILITY_LABEL,
  isRowSelected,
  onRowClick,
  onRowKeyboardNavigate,
  onRowSelectionToggle,
  onSelectAllRows,
  onRenderedItemsChange,
  renderCell,
  sortBy,
  sortDir = "asc",
  onSort,
  leadingSortKey,
  showGroupCounts = true,
  groups,
  groupIcon = null,
  onGroupDrop,
  rowDragHandleOnly, rowDragPreviewLabel, onRowDrop, canDropOnRow,
  canDragRow,
  canDropOnGroup,
  mode = "auto",
  preserveMeasuredContainer = false,
  pinLeadColumn = false,
  snapFoldToColumns = false,
  foldFitSettleMs = 0,
  columnOrder,
  onColumnOrderChange,
  columnWidths,
  onColumnWidthChange,
  movableColumnIds,
  resizableColumnIds,
  headerActions,
  trailingHeader,
  renderAfterRows,
  renderAfterItem,
  renderAfterGroup,
  virtualizeRows = false,
  suppressCellTabStops = false,
  navigableHeaderCells = false,
  alignValuesToColumn = false,
  enableRowRangeDrag = false,
  onRowRangeDrag,
  preferredActiveCellKey,
  getChildren,
  defaultExpandedRowIds,
  onRowExpandedChange,
  expandRowLabel,
  collapseRowLabel,
  groupCollapse,
  rowExpansion,
  showSelectAll = false,
  allSelected,
  someSelected,
  onSelectAll,
  leadingSortOptions,
  onClearSort,
}: GridTableV2Props<T>) {
  const gridBodyRef = useGridCellTabStops(suppressCellTabStops);
  const [internalCollapsedGroups, setInternalCollapsedGroups] = useState<
    Set<string>
  >(() => new Set());
  // ISS-9335: a host-owned port ANSWERS, the internal state REMEMBERS, and
  // exactly one of them is consulted — so the grid never holds a second copy of
  // a fact the host is already persisting.
  const collapsedGroups = groupCollapse
    ? collectCollapsedGroupKeys(groups, groupCollapse.isCollapsed)
    : internalCollapsedGroups;
  // ISS-8921 row lineage. Bounded on every write (see `nextExpandedRowIds`), so
  // a long session that pages through data cannot accumulate an id per row ever
  // opened. Seeded once — `defaultExpandedRowIds` is an initial state, not a
  // controlled value, so a caller re-deriving the array does not reopen rows the
  // user closed.
  const [internalExpandedRowIds, setInternalExpandedRowIds] = useState<
    Set<string>
  >(() => new Set(defaultExpandedRowIds ?? []));
  // ISS-9335 / marisolashgrove PR #7325: the host-owned expansion predicate is
  // read lazily. Materializing a Set walked deep trees twice and added no bound:
  // the flattener can only ask about rows the mounted hierarchy reaches.
  const expandedRowIds: ExpandedRowLookup =
    rowExpansion && getChildren
      ? { has: (rowId: string) => rowExpansion.isExpanded(rowId) }
      : internalExpandedRowIds;
  // WAI-ARIA APG roving tabindex keeps one cell, rather than every cell, in the
  // tab order. `null` means the grid has not been entered yet.
  const [activeCellKey, setActiveCellKey] = useState<string | null>(null);

  const { orderedColumns, reorder, resize } =
    resolveGridTableV2ColumnControls({
      columns,
      columnOrder,
      columnWidths,
      movableColumnIds,
      onColumnOrderChange,
      onColumnWidthChange,
      resizableColumnIds,
    });
  const {
    ref: containerRef,
    width: containerWidth,
    measured: isContainerMeasured,
  } = useContainerWidth<HTMLDivElement>();

  // ISS-4906: the width the fold fit is DERIVED from, held still through a
  // continuous resize so the fitted identity track — and therefore every column
  // after it — stops stepping sideways at each fit threshold. A
  // `foldFitSettleMs` of 0 (the default) returns the measured width verbatim, so
  // an un-opted-in caller fits on every measurement exactly as before.
  const foldFitWidth = useSettledValue(containerWidth, foldFitSettleMs);
  const isNarrowViewport = useMediaQuery(
    GRID_TABLE_V2_NARROW_VIEWPORT_QUERY
  );

  // whitlockk review / ISS-8921: grouping supplies roots and lineage expands them.
  // One flattener per pass owns the cycle guard, so an id repeated across bands
  // cannot paint two rows with the same roving-focus key.
  const beginSiblingWalk = () =>
    createSiblingFlattener<T>({ expandedRowIds, getChildren, getRowId });
  const groupedItemsContext = groups
    ? { expandedRowIds, getChildren, getRowId, groups }
    : null;
  const ungroupedRows: GridRenderRow<T>[] = groups
    ? []
    : beginSiblingWalk()(items);
  const renderedItems = groupedItemsContext
    ? collectRenderedGroupRows({
        ...groupedItemsContext,
        collapsedGroups,
      }).map(toRenderedItem)
    : ungroupedRows.map(toRenderedItem);
  useGridRenderedItemsChange({
    getRowId,
    onChange: onRenderedItemsChange,
    renderedItems,
  });
  const toggleGroup = (key: string) => {
    const next = nextCollapsedGroupKeys(collapsedGroups, key);
    if (groupCollapse) {
      groupCollapse.setCollapsed(key, next.collapsed);
      return;
    }
    setInternalCollapsedGroups(next.keys);
  };
  const findRenderedItem = (rowId: string): T | undefined =>
    renderedItems.find((candidate) => getRowId(candidate) === rowId);

  // ISS-12288: only flat, fixed-height rows are windowed. Selection and
  // navigation still receive the whole population, never the painted slice.
  const virtualizeBody =
    virtualizeRows && groups === undefined && renderAfterItem === undefined;
  // A ref avoids a second render for the row identity focus already updates.
  const focusedRowId = useRef<string | null>(null);
  // The leading spacer is the stable row-zero anchor beneath the sticky header.
  const { attachRowsAnchor, rowWindow, scrollRowIntoView } = useGridRowWindow({
    enabled: virtualizeBody,
    rowCount: ungroupedRows.length,
  });
  // Never parse a row id back out of a cell key; ids may contain its separator.
  const retainedRowIndex = virtualizeBody
    ? ungroupedRows.findIndex((row) => row.rowId === focusedRowId.current)
    : -1;
  const rowPaintPlan = resolveGridRowPaintPlan({
    retainedIndex: retainedRowIndex === -1 ? null : retainedRowIndex,
    rowCount: ungroupedRows.length,
    rowWindow,
  });
  // marisolashgrove review: keys come from painted rows plus the retained focused
  // row, so ordinary scrolling cannot drop the grid's only tab stop.
  const paintedRows = virtualizeBody
    ? collectPaintedRows(ungroupedRows, rowPaintPlan)
    : ungroupedRows;
  const paintedItems = virtualizeBody
    ? paintedRows.map(toRenderedItem)
    : renderedItems;

  const leadingUtilityFallbackHeader =
    renderLeadingUtility && renderLeadingUtilityInWide ? (
    <span className="sr-only">{leadingUtilityLabel}</span>
      ) : undefined;
  const unresolvedLeadingUtilityHeader =
    leadingUtilityHeader || leadingUtilityFallbackHeader;
  const {
    hasLeadingUtilityTrack,
    isNarrow,
    paintsBodyUtility,
    paintsHeaderUtility,
    pinnedIdentityLeft,
    pinsLeadColumn,
    renderedColumns,
    renderedGridTemplateColumns,
    rendersTrailingTrack,
    tracks,
    utilityColumnPinned,
  } = resolveGridTableV2Layout({
    bodyHasLeadingUtility: renderLeadingUtility != null,
    bodyUtilityInWide: renderLeadingUtilityInWide,
    columns: orderedColumns,
    foldFitWidth,
    gridTemplateColumns,
    hasTrailingTrack: Boolean(trailingHeader),
    headerHasLeadingUtility:
      renderLeadingUtilityInWide && Boolean(unresolvedLeadingUtilityHeader),
    isContainerMeasured,
    isNarrowViewport,
    mode,
    pinLeadColumn,
    snapFoldToColumns,
  });
  const resolvedLeadingUtilityHeader = paintsHeaderUtility
    ? unresolvedLeadingUtilityHeader
    : undefined;
  // The grid's keyboard entry point before any cell has been focused: the FIRST
  // cell of the first rendered row, which is the utility cell when the caller
  // renders one and the lead cell otherwise. Entering at the lead while a
  // utility cell sits to its left would put the grid's entry point in the
  // middle of the row.
  const firstRenderedItem = paintedItems[0];
  const firstColumnKey = hasLeadingUtilityTrack
    ? UTILITY_CELL_COLUMN_KEY
    : LEAD_CELL_COLUMN_KEY;
  // ISS-8219: a row painted into an after-row slot is a real row of THIS grid,
  // so its cells belong to the same roving tab stop as the data cells. Each slot
  // is evaluated ONCE here and its node reused at the render site, so what is
  // registered below is what the slot actually produced.
  const afterRows = resolveAfterRows({
    collapsedGroups,
    getRowId,
    groups,
    renderAfterGroup,
    renderAfterItem,
    renderAfterRows,
    renderedItems,
  });
  // A body whose only row is its create row would otherwise have NO cell in the
  // tab order at all: every cell compares unequal to a null active key.
  const firstCellKey = buildFirstCellKey(
    firstRenderedItem === undefined ? undefined : getRowId(firstRenderedItem),
    firstColumnKey,
    afterRows.ids[0]
  );
  // The roving tabindex must never point at a cell that is no longer on screen.
  // A data change (a page/filter change dropping the focused row) or a group
  // collapse leaves `activeCellKey` naming a row nothing renders — and because
  // every OTHER cell then compares unequal, the whole grid goes `tabIndex={-1}`
  // and drops out of the tab order entirely. Fall back to the first rendered
  // cell whenever the remembered key is not among the keys this render emits.
  // Membership is computed against the rendered keys rather than parsed out of
  // the string, because a row id may itself contain the separator.
  // ISS-8930: the chrome rows the header and each band paint, when they are in
  // the roving model. Registered exactly like the data and after-row keys,
  // because the staleness fallback below is what keeps SOME cell in the tab
  // order — a group header whose band stopped painting must stop being a
  // candidate or the grid can settle on a key no cell answers to.
  const headerCellColumnKeys = navigableHeaderCells
    ? buildHeaderCellColumnKeys(
        renderedColumns.map((column) => column.id),
        Boolean(resolvedLeadingUtilityHeader),
        // Only a caller that took the seam. A `ReactNode` trailing slot has
        // nowhere to receive the cell wiring, so registering a key for it would
        // put a roving candidate in the header that no cell answers to — the
        // staleness case the fallback below exists to prevent.
        rendersTrailingTrack && typeof trailingHeader === "function"
      )
    : [];
  const groupHeaderRowIds =
    navigableHeaderCells && groups
      ? collectGroupHeaderRowIds(groups, collapsedGroups)
      : [];
  const renderedCellKeys = new Set([
    ...collectRenderedCellKeys({
      dataColumnIds: renderedColumns.map((column) => column.id),
      getRowId,
      hasLeadingUtility: hasLeadingUtilityTrack,
      renderedItems: paintedItems,
    }),
    ...afterRows.ids.flatMap(buildAfterRowCellKeys),
    ...headerCellColumnKeys.map((columnKey) =>
      buildChromeCellKey(HEADER_ROW_ID, columnKey)
    ),
    ...groupHeaderRowIds.map((rowId) =>
      buildChromeCellKey(rowId, GROUP_HEADER_COLUMN_KEY)
    ),
  ]);
  // The grid's whole row sequence, in the document order the DOM walk this
  // replaces would see it in: the column-header row when it is in the roving
  // model, then the data rows, then the trailing after-row slot. Both ends are
  // the same model rather than two edge cases (whitlockk, marisolashgrove review) —
  // which is what makes `Ctrl+Home` from a session reach the header and
  // `Ctrl+End` from a data row reach the create row, exactly as they do when
  // nothing is windowed.
  const { attachRowsSpacer, windowedRows } = useGridWindowedRowNavigation({
    attachRowsAnchor,
    enabled: virtualizeBody,
    leadingChromeRowIds: navigableHeaderCells ? [HEADER_ROW_ID] : [],
    onRowKeyboardNavigate,
    renderedItems,
    rows: ungroupedRows,
    rowWindow,
    scrollRowIntoView,
    trailingChromeRowIds:
      afterRows.rowsNode === null ? [] : [AFTER_ROWS_ROW_ID],
  });
  // Every row the grid would hold with nothing windowed: the column-header row,
  // the whole data population, and the trailing after-row slot when one paints.
  // Resolved once rather than at each site that publishes it, so the count on
  // the grid and the index on its last row cannot disagree.
  const windowedAriaRowCount =
    ARIA_HEADER_ROW_COUNT +
    ungroupedRows.length +
    (afterRows.rowsNode === null ? 0 : 1);
  // A grid whose body paints no data row and no after-row has no data cell to
  // enter at. Before ISS-8930 that meant the whole grid left the tab order,
  // which was survivable only because the header's own controls still had their
  // native tab stops; once the header is in the roving model and its controls
  // are suppressed, the same fallback would be a grid with NO tab stop at all —
  // every control in it unreachable. The header's first cell is that floor.
  const entryCellKey =
    firstCellKey ??
    (headerCellColumnKeys[0] === undefined
      ? null
      : buildChromeCellKey(HEADER_ROW_ID, headerCellColumnKeys[0]));
  const rememberedCellKey =
    activeCellKey && renderedCellKeys.has(activeCellKey) ? activeCellKey : null;
  // ISS-9555: the caller's resume target, consulted ONLY once the remembered
  // key is gone — a reader who is still in the grid keeps their cell, and a
  // caller can never pull the tab stop out from under them. Membership-tested
  // against this render's own keys for the same reason the remembered key is:
  // a key naming a row this page does not paint would take the whole grid out
  // of the tab order.
  const preferredCellKey =
    preferredActiveCellKey && renderedCellKeys.has(preferredActiveCellKey)
      ? preferredActiveCellKey
      : null;
  const effectiveActiveCellKey =
    rememberedCellKey ?? preferredCellKey ?? entryCellKey;

  /**
   * Per-cell navigation props: the cell becomes focusable with a roving
   * tabindex, so the active cell (or the first cell before the grid has been
   * entered) is the table's single tab stop.
   */
  const buildCellNavigationProps = (
    cellKey: string,
    dataRowId?: string
  ): GridCellNavigationProps => ({
    "data-grid-cell": "",
    // Only when the CELL ITSELF takes focus. React's `onFocus` is `focusin`,
    // so it also fires for every descendant — and a v2 cell's descendants
    // include popover triggers and inline editors. Re-keying the roving
    // tabindex on those re-renders the table underneath an open popover while
    // the user is interacting with it.
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        focusedRowId.current = dataRowId ?? null;
        setActiveCellKey(cellKey);
      }
    },
    tabIndex: cellKey === effectiveActiveCellKey ? 0 : -1,
  });

  /**
   * The same wiring for a CHROME cell (ISS-8930). No `selectionKeys`: a header
   * is not one of the caller's selectable rows, so `Space` and `Ctrl/Cmd+A`
   * keep their native meaning there — the same reason an after-row's cells get
   * none. `navigateToRow` still runs and finds no item for a chrome row id,
   * which is what keeps the shared handler off its "selection follows focus"
   * fallback rather than clicking the header the user merely arrowed onto.
   *
   * `windowedRows` reaches here too (whitlockk review): the header is a row of the
   * same population, so `Ctrl+End` pressed on it has to resolve against that
   * population rather than walk to the last row the body happened to paint.
   */
  const buildChromeCellProps = (
    rowId: string,
    columnKey: string
  ): GridChromeCellProps => ({
    ...buildCellNavigationProps(buildChromeCellKey(rowId, columnKey)),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) {
        return;
      }
      handleGridCellKeyDown(
        event,
        navigateToRow,
        undefined,
        undefined,
        windowedRows
      );
    },
  });

  // Auto keeps a stable measured wrapper for viewport transitions; explicit
  // modes need it only when ISS-4889 whole-column fold fitting needs a width.
  const hasMeasuredContainer =
    mode === "auto" ||
    preserveMeasuredContainer ||
    snapFoldToColumns ||
    cardRender != null;
  const showCards = cardRender != null && isGridTableV2CardMode(mode, containerWidth);
  const hasSelection =
    isNarrow &&
    hasSelectedGridTableV2Row({
      getChildren,
      getRowId,
      groups,
      isRowSelected,
      items,
    });

  const navigateToRow = (
    rowId: string,
    event: KeyboardEvent<HTMLDivElement>
  ) => {
    const destination = findRenderedItem(rowId);
    if (destination) {
      onRowKeyboardNavigate?.(destination, event, renderedItems);
    }
  };

  // ISS-8747. The grid decides nothing about the range: it reports the press
  // row unmodified and each row the pointer reaches carrying `shiftKey`, and
  // the host resolves both through the same `resolveGridRowSelection` its click
  // and `Shift`-click already go through.
  const reportRangeDrag = (
    rowId: string,
    modifiers: GridSelectionModifiers
  ) => {
    const item = findRenderedItem(rowId);
    if (item) {
      onRowRangeDrag?.(item, modifiers, renderedItems);
    }
  };
  const nativeRowDragEnabled = onGroupDrop != null || onRowDrop != null;
  const isNativeRowDragEnabled = (item: T) =>
    nativeRowDragEnabled && (canDragRow?.(item) ?? true);
  const rowDragStartX = useRef(0);
  const [rowDropTarget,setRowDropTarget]=useState<{id:string;placement:"before"|"inside"|"after"}|null>(null);
  const draggedItemRef = useRef<T | undefined>(undefined);
  const draggingRowRef = useRef<HTMLElement | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewChipProps | null>(null);
  const clearDragPreview = () => {
    if (draggingRowRef.current) {
      delete draggingRowRef.current.dataset.dragging;
      draggingRowRef.current = null;
    }
    setDragPreview(null);
  };
  const rangeDragEnabled = enableRowRangeDrag && onRowRangeDrag != null;
  // Both gestures live on one press, and `dragstart` wins it: it fires at the
  // browser's own few-pixel threshold and cancels the pointer stream, so a range
  // started from an unmodified press dies at its first move. `Alt` picks the
  // range (operator ruling, 2026-09-04); UNMODIFIED stays the native group drag
  // that ships today, so an existing user's press is unchanged. `Shift` was not
  // available for this — it is already the range-extend-from-anchor modifier on
  // these same rows, and splitting two range meanings across click-vs-drag on
  // one key is worse than either.
  //
  // Watched only where the two actually collide; elsewhere `Alt` changes
  // nothing about `draggable`.
  const rangeDragModifierHeld = useAltKeyHeld(
    rangeDragEnabled && nativeRowDragEnabled && !rowDragHandleOnly
  );
  const rowRangeDrag = useGridRowRangeDrag({
    enabled: rangeDragEnabled,
    isInteractiveTarget: isInteractiveRowClickTarget,
    onExtendToRow: (rowId) =>
      reportRangeDrag(rowId, ROW_DRAG_EXTEND_MODIFIERS),
    onStartAtRow: (rowId) => reportRangeDrag(rowId, ROW_DRAG_ANCHOR_MODIFIERS),
    requireModifier: nativeRowDragEnabled && !rowDragHandleOnly,
  });
  const touchSelection = useGridTableV2TouchSelection({
    enabled: isNarrow,
    getCurrentItem: (rowId) =>
      findGridTableV2Row({
        getChildren,
        getRowId,
        groups,
        items,
        rowId,
      }),
    getRowId,
    hasSelection,
    onToggle: onRowSelectionToggle,
  });

  // Each half stays `undefined` unless its own prop was wired, because the
  // shared handler treats a missing callback as "not my key" and leaves it its
  // native meaning — an object of two `undefined`s would swallow nothing, but a
  // wrapper that always exists would claim `Space` for a host that never asked.
  const selectionKeys: GridSelectionHandlers | undefined =
    onRowSelectionToggle || onSelectAllRows
      ? {
          onSelectAllRows: onSelectAllRows
            ? () => onSelectAllRows(renderedItems)
            : undefined,
          onToggleRowSelection: onRowSelectionToggle
            ? (rowId: string) => {
                const item = findRenderedItem(rowId);
                if (item) {
                  onRowSelectionToggle(item);
                }
              }
            : undefined,
        }
      : undefined;

  const { expansionKeys, setRowExpanded } = createGridRowExpansionCommands({
    expandedRowIds,
    findRenderedItem,
    getChildren,
    getRowId,
    groups,
    items,
    onRowExpandedChange,
    rowExpansion,
    setInternalExpandedRowIds,
  });

  // The cell wiring an after-row slot needs to render itself as a row of this
  // grid. No `selectionKeys` — an after-row is not one of the caller's
  // selectable items, so `Space` keeps its native meaning there.
  //
  // Deliberately NOT memoized: `buildCellNavigationProps` closes over
  // `effectiveActiveCellKey`, so the value MUST change whenever the roving tab
  // stop moves or the after-row's cells would keep a stale `tabIndex`.
  // `ariaRowIndex` is supplied only by the windowed body, the one shape where a
  // reader cannot count the rows above this one for themselves (whitlockk review).
  const renderAfterRow = (
    rowId: string,
    node: ReactNode,
    ariaRowIndex?: number
  ): ReactNode => (
    <GridTableAfterRowProvider
      value={{
        ariaRowIndex,
        gridTemplateColumns: renderedGridTemplateColumns,
        getCellProps: (columnKey: string) => ({
          ...buildCellNavigationProps(buildAfterRowCellKey(rowId, columnKey)),
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) =>
            handleGridCellKeyDown(
              event,
              navigateToRow,
              undefined,
              undefined,
              windowedRows
            ),
        }),
        isNarrowList: isNarrow,
        rowId,
      }}
    >
      {node}
    </GridTableAfterRowProvider>
  );

  /** A band header's roving wiring, or `undefined` while the flag is closed. */
  const buildGroupHeaderNavigation = (bandKey: string) => {
    if (!navigableHeaderCells) {
      return;
    }
    const rowId = buildGroupHeaderRowId(bandKey);
    return {
      cellProps: buildChromeCellProps(rowId, GROUP_HEADER_COLUMN_KEY),
      rowId,
    };
  };

  /**
   * The trailing header slot, with its roving cell wiring handed to the caller
   * when it took the function form (whitlockk review).
   *
   * The grid cannot wrap the slot to make it navigable: the caller already gives
   * that element `role="columnheader"` and its `aria-colindex`, and a generic
   * wrapper between it and the header row would orphan the `columnheader` from
   * its `row` parent. So the wiring goes OUT rather than the markup coming in.
   */
  let resolvedTrailingHeader: ReactNode;
  if (rendersTrailingTrack) {
    resolvedTrailingHeader =
      typeof trailingHeader === "function"
        ? trailingHeader(
            navigableHeaderCells
              ? buildChromeCellProps(HEADER_ROW_ID, TRAILING_HEADER_COLUMN_KEY)
              : undefined
          )
        : trailingHeader;
  }

  const renderAfterGroupRow = (groupKey: string): ReactNode => {
    const node = afterRows.groupNodes.get(groupKey);
    return node === undefined
      ? null
      : renderAfterRow(buildAfterGroupRowId(groupKey), node);
  };

  // `ariaRowIndex` is supplied only by the windowed body; see `renderAfterRow`.
  const renderRow = (
    row: GridRenderRow<T>,
    ariaRowIndex?: number
  ): ReactNode =>
    renderGridTableV2Row({
      alignValuesToColumn,
      dragHandleOnly:rowDragHandleOnly,
      rowDropProps:onRowDrop ? {
        "data-row-drop":rowDropTarget?.id===row.rowId ? rowDropTarget.placement:undefined,
        onDragOver:(event)=>{
          const targetElement = event.currentTarget;
          const pointerY = event.clientY;
          const dragged=draggedItemRef.current;
          if(!dragged){
            setDragPreview((current) => current ? { ...current, dropTarget: undefined, y: pointerY } : null);
            return;
          }
          const rect=targetElement.getBoundingClientRect();
          const y=event.clientY-rect.top;
          let placement:"before"|"inside"|"after"=y<rect.height/2?"before":"after";
          if(event.clientX-rowDragStartX.current>24 && y>rect.height/4 && y<rect.height*3/4) placement="inside";
          if(dragged===row.item || canDropOnRow?.(dragged,row.item,placement)===false){
            event.stopPropagation();event.dataTransfer.dropEffect="none";setRowDropTarget(null);
            setDragPreview((current) => current ? { ...current, dropTarget: undefined, y: pointerY } : null);
            return;
          }
          setDragPreview((current) => current ? {
            ...current,
            dropTarget: { element: targetElement, placement },
            y: pointerY,
          } : null);
          event.preventDefault();event.stopPropagation();setRowDropTarget({id:row.rowId,placement});
        },
        onDrop:(event)=>{
          const dragged=draggedItemRef.current;const target=rowDropTarget;
          if(dragged){event.preventDefault();event.stopPropagation();}
          if(dragged&&target?.id===row.rowId&&canDropOnRow?.(dragged,row.item,target.placement)!==false){event.preventDefault();event.stopPropagation();onRowDrop(dragged,row.item,target.placement);}
          setRowDropTarget(null);draggedItemRef.current=undefined;
          clearDragPreview();
        }
      }:undefined,
      ariaRowIndex,
      buildCellNavigationProps,
      collapseRowLabel,
      columns: renderedColumns,
      expandRowLabel,
      expansionKeys,
      hasLeadingUtilityTrack,
      hasTrailingCell: rendersTrailingTrack,
      isNativeRowDragEnabled,
      isNarrowList: isNarrow,
      isRowSelected,
      navigateToRow,
      onDragEndRow: () => {
        setRowDropTarget(null);
        draggedItemRef.current = undefined;
        clearDragPreview();
      },
      onDragStartRow: (event, dragged) => {
        if(rowDragHandleOnly && (!(event.target instanceof Element) || !event.target.closest("[data-grid-row-drag-handle]"))) {event.preventDefault();return;}
        rowDragStartX.current=event.clientX;
        if (
          isNativeRowDragEnabled(dragged.item) &&
          startGridRowDrag(event, dragged.rowId)
        ) {
          draggedItemRef.current = dragged.item;
          const label = rowDragPreviewLabel?.(dragged.item);
          if (label) {
            const source = event.currentTarget;
            const rect = source.getBoundingClientRect();
            const handle = source.querySelector<HTMLElement>(
              "[data-grid-row-drag-handle]"
            );
            source.dataset.dragging = "true";
            draggingRowRef.current = source;
            setDragPreview({
              label,
              sourceElement: source,
              x: handle?.getBoundingClientRect().left ?? rect.left,
              y: event.clientY,
            });
            hideNativeDragImage(event.dataTransfer);
          }
        }
      },
      onRowClick,
      pinLeadColumn: pinsLeadColumn,
      pinnedIdentityLeft,
      rangeDragModifierHeld,
      renderCell,
      renderLead,
      renderLeadingUtility: paintsBodyUtility
        ? renderLeadingUtility
        : undefined,
      renderNarrowTrailingAction,
      renderedGridTemplateColumns,
      renderedItems,
      row,
      rowRangeDragProps: rowRangeDrag.rowProps,
      selectionKeys,
      staticTableSemantics,
      setRowExpanded,
      touchSelection,
      tracks,
      utilityColumnPinned,
      windowedRows,
    });

  const renderGridItem = (row: GridRenderRow<T>): ReactNode => {
    const afterItem = afterRows.itemNodes.get(row.rowId);
    return (
      <Fragment key={row.rowId}>
        {renderRow(row)}
        {afterItem === undefined
          ? null
          : renderAfterRow(buildAfterItemRowId(row.rowId), afterItem)}
      </Fragment>
    );
  };

  const findItemByDragEvent = (
    event: DragEvent<HTMLElement>
  ): T | undefined => {
    const rowId = event.dataTransfer.getData(GRID_ROW_DRAG_TYPE);
    const item = rowId ? findRenderedItem(rowId) : draggedItemRef.current;
    if (item === undefined || !isNativeRowDragEnabled(item)) {
      return undefined;
    }
    return item;
  };
  const groupDropHandlers = createGroupDropHandlers({
    canDropOnGroup,
    findItemByDragEvent,
    onGroupDrop,
  });

  const renderCardItem = createGridTableV2CardRenderer({
    analyticsLabel: `Select ${leadingLabel.toLowerCase()}`,
    afterNodes: afterRows.itemNodes,
    collapseLabel: collapseRowLabel,
    columns: orderedColumns,
    expandLabel: expandRowLabel,
    getCardSelectionLabel,
    isRowSelected,
    onRowClick,
    onRowKeyboardNavigate,
    onRowSelectionToggle,
    onToggleExpanded: setRowExpanded,
    render: cardRender,
    renderedItems,
  });
  const cardList = cardRender ? (
    <GridTableV2CardList
      afterGroupNodes={afterRows.groupNodes}
      afterRowsNode={afterRows.rowsNode}
      beginSiblingWalk={beginSiblingWalk}
      collapsedGroups={collapsedGroups}
      groupDropHandlers={groupDropHandlers}
      groupIcon={groupIcon}
      groups={groups}
      renderCardItem={renderCardItem}
      showGroupCounts={showGroupCounts}
      toggleGroup={toggleGroup}
      ungroupedRows={ungroupedRows}
    />
  ) : null;

  const flattenGridSiblings = beginSiblingWalk();
  return (
    <>
    <GridTableV2Frame
      ariaColumnCount={tracks.columnCount}
      ariaRowCount={virtualizeBody ? windowedAriaRowCount : undefined}
      cardList={cardList}
      containerRef={containerRef}
      gridBodyRef={gridBodyRef}
      hasMeasuredContainer={hasMeasuredContainer}
      isMultiSelectable={selectionKeys !== undefined}
      isNarrowList={isNarrow}
      isTreeGrid={getChildren !== undefined}
      showCards={showCards}
      staticTableSemantics={staticTableSemantics}
    >
      <TableGridHeaderV2
        actions={headerActions}
        ariaRowIndex={virtualizeBody ? ARIA_HEADER_ROW_COUNT : undefined}
        columnTracks={tracks}
        insideAriaTable
        className={isNarrow ? "w-full min-w-0" : undefined}
        columns={renderedColumns.map((column) => ({
          id: column.id,
          label: column.label,
          sortable: onSort != null && column.sortable === true,
          filterable: column.filterable,
          groupable: column.groupable,
          className: column.className,
          tooltip: column.tooltip,
          ariaLabel: column.ariaLabel,
          align: column.align,
        }))}
        gridTemplateColumns={renderedGridTemplateColumns}
        leadingLabel={
          isNarrow ? GRID_TABLE_V2_NARROW_LEADING_LABEL : leadingLabel
        }
        leadingResize={
          !isNarrow && leadingColumnWidth != null && onLeadingColumnWidthChange
            ? {
                width: leadingColumnWidth,
                onResize: onLeadingColumnWidthChange,
              }
            : undefined
        }
        allSelected={allSelected}
        leadingSortKey={
          // Options and a single key are two spellings of one control, and the
          // header would silently prefer one; hand it only the one in force.
          leadingSortOptions?.length || !onSort ? undefined : leadingSortKey
        }
        leadingSortOptions={onSort ? leadingSortOptions : undefined}
        leadingTooltip={leadingTooltip}
        onClearSort={onClearSort}
        onSelectAll={onSelectAll}
        isNarrowList={isNarrow}
        showSelectAll={showSelectAll}
        someSelected={someSelected}
        leadingUtilityCell={resolvedLeadingUtilityHeader}
        navigation={
          navigableHeaderCells
            ? {
                getCellProps: (columnKey: string) =>
                  buildChromeCellProps(HEADER_ROW_ID, columnKey),
                rowId: HEADER_ROW_ID,
              }
            : undefined
        }
        onSort={onSort ?? noopSort}
        pinLeadColumn={pinsLeadColumn}
        reorder={isNarrow ? undefined : reorder}
        resize={isNarrow ? undefined : resize}
        sortBy={sortBy ?? null}
        sortDir={sortDir}
        trailingCell={resolvedTrailingHeader}
      />
      {groups ? (
        renderGridTableV2GroupedRows({
          collapsedGroups,
          columnCount: tracks.columnCount,
          flattenGridSiblings,
          groupDropHandlers,
          groupHeaderNavigation: buildGroupHeaderNavigation,
          groupIcon,
          groups,
          isNarrowList: isNarrow,
          renderAfterGroupRow,
          renderGridItem,
          showGroupCounts,
          staticTableSemantics,
          toggleGroup,
        })
      ) : (
        <>
          {virtualizeBody
            ? renderGridTableV2WindowedRows({
                attachRowsSpacer,
                ariaRowIndexOffset: ARIA_HEADER_ROW_COUNT,
                plan: rowPaintPlan,
                renderRow,
                rows: ungroupedRows,
              })
            : ungroupedRows.map(renderGridItem)}
          {afterRows.rowsNode === null
            ? null
            : renderAfterRow(
                AFTER_ROWS_ROW_ID,
                afterRows.rowsNode,
                virtualizeBody ? windowedAriaRowCount : undefined
              )}
        </>
      )}
    </GridTableV2Frame>
    {dragPreview
      ? createPortal(
          <DragPreviewChip {...dragPreview} />,
          globalThis.document.body
        )
      : null}
    </>
  );
}

/** Announce a name when the caller omits its utility label. */
const DEFAULT_LEADING_UTILITY_LABEL = "Actions";
function noopSort() {
  // Column sorting is not wired in this view yet.
}

function toRenderedItem<T>(row: GridRenderRow<T>): T {
  return row.item;
}
/**
 * `aria-rowindex` of the column-header row, which is also how many rows sit
 * above the data population: one. The header is `role="row"` whenever the grid
 * declares ARIA table semantics, whether or not it is in the roving model.
 */
const ARIA_HEADER_ROW_COUNT = 1;
