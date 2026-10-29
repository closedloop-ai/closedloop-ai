// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/a11y/noStaticElementInteractions: Preserve the approved Generic Artifact prototype interaction contract in this v2 component.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: Keyboard navigation is handled by the prototype's cell-level handlers.
"use client";

/**
 * One DATA row of a `GridTableV2` body: its row element, its two fixed leading
 * cells, and one cell per data column.
 *
 * Lifted out of `grid-table-v2.tsx` (marisolashgrove review) as the largest single
 * responsibility in a file over the 1,000-line ceiling — "paint one row" is a
 * concern the compositor around it does not need to read to understand what it
 * composes. Nothing about the row's markup changed in the move.
 *
 * A plain function rather than a component for the reason the windowed-rows
 * module is one: the row element must be a DIRECT child of the `role="grid"`,
 * which owns only rows and rowgroups, and the caller still owns the key.
 */

import { resolveCellAlignEnd } from "@closedloop-ai/design-system/lib/column-cell-alignment";
import { ColumnAlignment } from "@closedloop-ai/design-system/lib/column-registry";
import type { GridColumnTracks } from "@closedloop-ai/design-system/lib/grid-table-aria";
import {
  type GridRowExpansionHandlers,
  type GridSelectionHandlers,
  type GridWindowedRowNavigation,
  handleGridCellKeyDown,
} from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import { gridRowActionProps } from "@closedloop-ai/design-system/lib/grid-row-action";
import {
  PINNED_LEAD_AFTER_UTILITY_CELL_CLASS,
  PINNED_LEAD_CELL_CLASS,
  PINNED_LEAD_EDGE_CLASS,
  PINNED_LEAD_UTILITY_CELL_CLASS,
  pinnedLeadTintClasses,
  ROW_HOVER_TINT_CLASS,
  ROW_SELECTED_TINT_CLASS,
} from "@closedloop-ai/design-system/lib/grid-table-pin";
import type { GridCellNavigationProps } from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import {
  buildCellKey,
  LEAD_CELL_COLUMN_KEY,
  UTILITY_CELL_COLUMN_KEY,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import {
  type GridRenderRow,
  treeRowAriaProps,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type {
  GridTableV2Column,
  GridTableV2LeadContext,
  GridTableV2Props,
} from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { GridTableV2TouchSelection } from "@closedloop-ai/design-system/hooks/use-grid-table-v2-touch-selection";
import type {
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  PointerEventHandler,
  ReactNode,
} from "react";
import {
  canStartGridRowDragFromTarget,
  GRID_ROW_DRAG_TYPE,
} from "../../lib/grid-table-v2-group-drop";
import {
  clearGridDragOverStates,
  clearGridInteractionState,
  GridInteractionState,
  hasGridInteractionContract,
  setGridInteractionState,
} from "../../lib/grid-interaction-contract";
import {
  beginGridRowDragPointerIntent,
  cancelGridRowDragPointerIntent,
} from "../../lib/grid-row-drag-pointer-intent";
import { GRID_NAV_CELL_ROLE, GridTableV2Cell } from "./grid-table-v2-cell";
import { Checkbox } from "./checkbox";
import { GridTableV2TreeLead } from "./grid-table-v2-tree-lead";
import { useGridInteractionContractEnabled } from "./grid-interaction-contract";

export type GridTableV2RowProps<T> = {
  alignValuesToColumn: boolean;
  /**
   * The row's 1-based `aria-rowindex`, supplied only by a body that paints a
   * WINDOW of its rows (ISS-12288) — the one shape where a reader cannot count
   * the rows above this one for themselves.
   */
  ariaRowIndex?: number;
  dragHandleOnly?: boolean;
  rowDropProps?: { onDragOver: (event: DragEvent<HTMLDivElement>) => void; onDrop: (event: DragEvent<HTMLDivElement>) => void; "data-row-drop"?: string };
  buildCellNavigationProps: (
    cellKey: string,
    dataRowId?: string
  ) => GridCellNavigationProps;
  collapseRowLabel?: string;
  columns: readonly GridTableV2Column[];
  expandRowLabel?: string;
  expansionKeys?: GridRowExpansionHandlers;
  /** Whether the caller's trailing header track gets a phantom body cell. */
  hasTrailingCell: boolean;
  hasLeadingUtilityTrack: boolean;
  isNativeRowDragEnabled: (item: T) => boolean;
  isNarrowList: boolean;
  isRowSelected?: (item: T) => boolean;
  navigateToRow: (rowId: string, event: KeyboardEvent<HTMLDivElement>) => void;
  onDragEndRow: () => void;
  onDragStartRow: (
    event: DragEvent<HTMLDivElement>,
    row: GridRenderRow<T>
  ) => void;
  onRowClick?: (
    item: T,
    event: MouseEvent<HTMLDivElement>,
    items: readonly T[]
  ) => void;
  pinLeadColumn: boolean;
  pinnedIdentityLeft?: string;
  rangeDragModifierHeld: boolean;
  renderCell: (columnId: string, item: T) => ReactNode;
  renderLead: (item: T, context: GridTableV2LeadContext) => ReactNode;
  renderLeadingUtility?: GridTableV2Props<T>["renderLeadingUtility"];
  renderNarrowTrailingAction?: GridTableV2Props<T>["renderNarrowTrailingAction"];
  renderedGridTemplateColumns: string;
  renderedItems: readonly T[];
  row: GridRenderRow<T>;
  /** The press handler a range-drag-enabled body puts on every row. */
  rowRangeDragProps?: { onPointerDown: PointerEventHandler<HTMLDivElement> };
  selectionKeys?: GridSelectionHandlers;
  staticTableSemantics: boolean;
  setRowExpanded: (rowId: string, expanded: boolean) => void;
  touchSelection: GridTableV2TouchSelection<T>;
  tracks: GridColumnTracks;
  utilityColumnPinned: boolean;
  windowedRows?: GridWindowedRowNavigation<KeyboardEvent<HTMLDivElement>>;
};

export function renderGridTableV2Row<T>(
  props: GridTableV2RowProps<T>
): ReactNode {
  return <GridTableV2Row key={props.row.rowId} {...props} />;
}

function GridTableV2Row<T>({
  alignValuesToColumn,
  ariaRowIndex,
  dragHandleOnly, rowDropProps,
  buildCellNavigationProps,
  collapseRowLabel,
  columns,
  expandRowLabel,
  expansionKeys,
  hasLeadingUtilityTrack,
  hasTrailingCell,
  isNativeRowDragEnabled,
  isNarrowList,
  isRowSelected,
  navigateToRow,
  onDragEndRow,
  onDragStartRow,
  onRowClick,
  pinLeadColumn,
  pinnedIdentityLeft,
  rangeDragModifierHeld,
  renderCell,
  renderLead,
  renderLeadingUtility,
  renderNarrowTrailingAction,
  renderedGridTemplateColumns,
  renderedItems,
  row,
  rowRangeDragProps,
  selectionKeys,
  staticTableSemantics,
  setRowExpanded,
  tracks,
  touchSelection,
  utilityColumnPinned,
  windowedRows,
}: GridTableV2RowProps<T>): ReactNode {
  const interactionContractEnabled = useGridInteractionContractEnabled();
  const { item, rowId, tree } = row;
  const selected = isRowSelected?.(item) === true;
  const rowAction = gridRowActionProps(item, renderedItems, onRowClick);
  const lead =
    tree === null ? (
      renderLead(item, { isNarrowList })
    ) : (
      <GridTableV2TreeLead
        collapseLabel={collapseRowLabel}
        expandLabel={expandRowLabel}
        onToggle={(expanded) => setRowExpanded(rowId, expanded)}
        tree={tree}
      >
        {renderLead(item, { isNarrowList })}
      </GridTableV2TreeLead>
    );
  const narrowSelectionControl =
    isNarrowList && selectionKeys?.onToggleRowSelection && isRowSelected ? (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Checkbox
          aria-label={selected ? "Deselect row" : "Select row"}
          checked={selected}
          className="size-6"
          onCheckedChange={() =>
            selectionKeys.onToggleRowSelection?.(rowId)
          }
        />
      </div>
    ) : null;
  const narrowTrailingAction = isNarrowList
    ? renderNarrowTrailingAction?.(item)
    : null;
  // whitlockk review (#9095): the lead keeps one parent chain in both layouts, so
  // crossing the narrow breakpoint never remounts an open inline editor. Wide
  // rows flatten the wrappers with `contents`; only the optional siblings vary.
  const composedLead = (
    <div className={isNarrowList ? "flex min-w-0 items-center gap-1" : "contents"}>
      {narrowSelectionControl}
      <div className={isNarrowList ? "min-w-1/2 flex-1" : "contents"}>
        {lead}
      </div>
      {isNarrowList && renderLeadingUtility ? (
        // The utility yields width before the identity does, so a wide value
        // such as a tag list cannot crush the row's title (ISS-9523).
        <div className="flex min-w-0 shrink items-center">
          {renderLeadingUtility(item, { isNarrowList })}
        </div>
      ) : null}
      {narrowTrailingAction ? (
        <div className="flex shrink-0 items-center">{narrowTrailingAction}</div>
      ) : null}
    </div>
  );
  const nativeRowDragEnabled =
    isNativeRowDragEnabled(item) && !rangeDragModifierHeld;
  const pointerIntentHandlers =
    interactionContractEnabled && nativeRowDragEnabled
      ? {
          onLostPointerCapture: (
            event: ReactPointerEvent<HTMLDivElement>
          ) =>
            cancelGridRowDragPointerIntent(
              event.currentTarget,
              event.pointerId
            ),
          onPointerCancelCapture: (
            event: ReactPointerEvent<HTMLDivElement>
          ) =>
            cancelGridRowDragPointerIntent(
              event.currentTarget,
              event.pointerId
            ),
          onPointerDownCapture: (
            event: ReactPointerEvent<HTMLDivElement>
          ) =>
            beginGridRowDragPointerIntent(
              event,
              canStartGridRowDragFromTarget(event.target)
            ),
          onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) =>
            cancelGridRowDragPointerIntent(
              event.currentTarget,
              event.pointerId
            ),
        }
      : undefined;
  return (
    <div
      aria-rowindex={ariaRowIndex}
      aria-selected={isRowSelected ? selected : undefined}
      {...treeRowAriaProps(tree)}
      className={cn(
        // Both the bare group and the NAMED one (ISS-9335). Bare is what
        // every existing `group-hover:` inside a cell already keys off, and
        // named is what a host's own row-scoped reveal needs: a cell's
        // `group/cell` shadows the bare name, so an affordance that must
        // appear on ROW hover — a checkbox revealed on hover, a drag grip —
        // has no unnamed group to reach past it.
        "group/row group grid items-center border-b bg-[var(--grid-table-surface,var(--background))] data-[dragging=true]:bg-accent/40 data-[row-drop=before]:border-t-primary data-[row-drop=after]:border-b-primary data-[row-drop=inside]:ring-1 data-[row-drop=inside]:ring-primary",
        isNarrowList
          ? "data-[row-drop=before]:border-t-2 data-[row-drop=after]:border-b-2"
          : "data-[row-drop=before]:border-t data-[row-drop=after]:border-b",
        isNarrowList
          ? "w-full min-w-0 pointer-coarse:select-none"
          : "min-w-fit",
        isNarrowList && ariaRowIndex === undefined ? "min-h-11" : "h-11",
        selected ? ROW_SELECTED_TINT_CLASS : ROW_HOVER_TINT_CLASS
      )}
      {...rowAction}
      data-grid-row=""
      data-grid-row-id={rowId}
      data-grid-card-id={isNarrowList ? rowId : undefined}
      data-grid-selectable-row={rowRangeDragProps ? "" : undefined}
      data-state={selected ? "selected" : undefined}
      draggable={!dragHandleOnly && nativeRowDragEnabled}
      {...rowDropProps}
      key={rowId}
      {...pointerIntentHandlers}
      onClick={(event) => touchSelection.onClick(item, event, rowAction.onClick)}
      onContextMenu={touchSelection.onContextMenu}
      onDragEnd={(event) => {
        if (hasGridInteractionContract(event.currentTarget)) {
          cancelGridRowDragPointerIntent(event.currentTarget);
          clearGridInteractionState(event.currentTarget, GridInteractionState.Dragging);
          clearGridDragOverStates(event.currentTarget);
        }
        onDragEndRow();
      }}
      onDragStart={(event) => {
        if (hasGridInteractionContract(event.currentTarget) && !nativeRowDragEnabled) {
          return;
        }
        onDragStartRow(event, row);
        if (hasGridInteractionContract(event.currentTarget) && event.dataTransfer.getData(GRID_ROW_DRAG_TYPE) !== "") {
          setGridInteractionState(event.currentTarget, GridInteractionState.Dragging);
        }
      }}
      onPointerCancel={touchSelection.onPointerCancel}
      onPointerDown={(event) => {
        rowRangeDragProps?.onPointerDown(event);
        touchSelection.onPointerDown(item, event);
      }}
      onPointerMove={touchSelection.onPointerMove}
      onPointerUp={touchSelection.onPointerUp}
      role="row"
      style={{ gridTemplateColumns: renderedGridTemplateColumns }}
    >
      {hasLeadingUtilityTrack ? (
        // A real leading track always gets a body cell, so CSS placement and
        // ARIA numbering describe the same grid even when a caller supplies
        // only the header half.
        <div
          aria-colindex={tracks.leadingUtilityColumnIndex}
          className={cn(
            "flex h-full min-w-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            utilityColumnPinned && [
              PINNED_LEAD_UTILITY_CELL_CLASS,
              // No edge rule here: the pinned REGION's right-hand seam
              // belongs to the identity cell beside it, and a second rule
              // between the star and the name would draw a border the
              // unpinned table never has.
              ...pinnedLeadTintClasses(isRowSelected?.(item) === true),
            ]
          )}
          key={UTILITY_CELL_COLUMN_KEY}
          onKeyDown={
            staticTableSemantics
              ? undefined
              : (event) =>
                  handleGridCellKeyDown(
                    event,
                    navigateToRow,
                    selectionKeys,
                    undefined,
                    windowedRows,
                    tree !== null
                  )
          }
          role={staticTableSemantics ? "cell" : GRID_NAV_CELL_ROLE}
          {...(staticTableSemantics
            ? undefined
            : buildCellNavigationProps(
                buildCellKey(rowId, UTILITY_CELL_COLUMN_KEY),
                rowId
              ))}
        >
          {renderLeadingUtility?.(item, { isNarrowList })}
        </div>
      ) : null}
      <div
        aria-colindex={tracks.leadColumnIndex}
        data-grid-lead-cell=""
        className={cn(
          "flex min-w-0 flex-col justify-center py-1 pr-3 pl-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          // Rows are a fixed 44px, which the windowed body depends on, so an
          // open inline editor (28px field plus one 16px message line) fills
          // the row only without this cell's vertical padding, as it does in
          // an unpadded data cell. Resting content keeps the padding.
          INLINE_EDITOR_OPEN_LEAD_PADDING_CLASS,
          pinLeadColumn && [
            utilityColumnPinned
              ? PINNED_LEAD_AFTER_UTILITY_CELL_CLASS
              : PINNED_LEAD_CELL_CLASS,
            PINNED_LEAD_EDGE_CLASS,
            ...pinnedLeadTintClasses(isRowSelected?.(item) === true),
          ]
        )}
        key={LEAD_CELL_COLUMN_KEY}
        onKeyDown={
          staticTableSemantics
            ? undefined
            : (event) =>
                handleGridCellKeyDown(
                  event,
                  navigateToRow,
                  selectionKeys,
                  expansionKeys,
                  windowedRows,
                  tree !== null
                )
        }
        role={staticTableSemantics ? "cell" : GRID_NAV_CELL_ROLE}
        style={
          pinnedIdentityLeft === undefined
            ? undefined
            : { left: pinnedIdentityLeft }
        }
        {...(staticTableSemantics
          ? undefined
          : buildCellNavigationProps(
              buildCellKey(rowId, LEAD_CELL_COLUMN_KEY),
              rowId
            ))}
      >
        {composedLead}
      </div>
      {/* No trailing border cell: columns are separated by `border-l`; the
        table's left and right edges are intentionally open. (A fixed-size
        phantom trailing cell here used to overlap the first row's lead cell
        when a caller's template lacked a track for it.) */}
      {columns.map((column, index) => (
        <GridTableV2Cell
          // ISS-9821: the class below cannot move a value primitive that
          // right-aligns itself, so the alignment is published to it as well.
          cellAlignEnd={resolveCellAlignEnd(column.align, alignValuesToColumn)}
          cellRole={staticTableSemantics ? "cell" : GRID_NAV_CELL_ROLE}
          className={
            column.align === ColumnAlignment.End ? "justify-end" : undefined
          }
          colIndex={tracks.dataColumnIndex(index)}
          columnId={column.id}
          homeEndByRow={tree !== null}
          key={column.id}
          onKeyboardNavigate={staticTableSemantics ? undefined : navigateToRow}
          selectionKeys={selectionKeys}
          staticTableSemantics={staticTableSemantics}
          windowedRows={windowedRows}
          {...(staticTableSemantics
            ? undefined
            : buildCellNavigationProps(buildCellKey(rowId, column.id), rowId))}
        >
          {renderCell(column.id, item)}
        </GridTableV2Cell>
      ))}
      {hasTrailingCell ? (
        <GridTableV2Cell
          aria-hidden
          cellRole={staticTableSemantics ? "cell" : GRID_NAV_CELL_ROLE}
          colIndex={tracks.trailingColumnIndex}
          key="__trailing__"
        />
      ) : null}
    </div>
  );
}

/** Keyed off the `data-inline-editor-open` wrapper `InlineNameCell` renders while editing. */
const INLINE_EDITOR_OPEN_LEAD_PADDING_CLASS =
  "has-[[data-inline-editor-open]]:py-0";
