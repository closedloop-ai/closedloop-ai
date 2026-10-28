"use client";

/**
 * How a row painted into one of `GridTableV2`'s after-row slots
 * (`renderAfterRows`, `renderAfterGroup`, `renderAfterItem`) joins the grid it
 * is inserted into — ISS-8219.
 *
 * A slot's node renders UNDER the `role="grid"`, which owns only `row` and
 * `rowgroup`, so a plain `<div>` there is an orphan generic. A bare
 * `role="row"` is WORSE than that orphan: its cells then have to carry
 * `aria-colindex` values lining up with the header's run and the row has to
 * join the grid's single roving tab stop, and a row that misreports either
 * misdescribes the table's shape rather than being ignored. The grid therefore
 * publishes that bookkeeping instead of each slot re-deriving it.
 *
 * No provider means the consumer is not inside a grid — for example a
 * standalone story or the frozen legacy card-list compatibility surface — and
 * there the correct rendering is no row role at all.
 */

import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import {
  createContext,
  type FocusEvent,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  useContext,
} from "react";
import {
  buildAfterRowCellKey,
  buildCellKey,
  LEAD_CELL_COLUMN_KEY,
} from "./grid-table-v2-rows";

/**
 * The roving-tabindex wiring `GridTableV2` puts on every navigable cell. Owned
 * here rather than inferred from the builder's return so the grid's cells and
 * an after-row's cells cannot drift into two shapes: a field added to one is a
 * type error on the other.
 */
export type GridCellNavigationProps = {
  "data-grid-cell": "";
  onFocus: (event: FocusEvent<HTMLDivElement>) => void;
  tabIndex: number;
};

/** The same, plus the keydown an after-row's cell wires for itself. */
export type GridTableAfterRowCellProps = GridCellNavigationProps & {
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

export type GridTableAfterRowContextValue = {
  /** This slot's row id — distinct per group, so cell keys cannot collide. */
  rowId: string;
  /**
   * This row's 1-based `aria-rowindex` in the whole grid, published only where
   * the grid declares a row lattice at all — a body that paints a WINDOW of its
   * rows (ISS-12288). The slot's own markup applies it, because the row element
   * is the slot's, not the grid's. Absent → the attribute is omitted, exactly as
   * it was before an index existed to publish.
   */
  ariaRowIndex?: number;
  /** Whether the owning grid is projecting its canonical one-column list. */
  isNarrowList: boolean;
  /** The exact track template currently shared by the owning header and rows. */
  gridTemplateColumns: string;
  getCellProps: (columnKey: string) => GridTableAfterRowCellProps;
};

const GridTableAfterRowContext =
  createContext<GridTableAfterRowContextValue | null>(null);

export const GridTableAfterRowProvider = GridTableAfterRowContext.Provider;

export function useGridTableAfterRow(): GridTableAfterRowContextValue | null {
  return useContext(GridTableAfterRowContext);
}

/**
 * Namespace keeping the three slots' ids apart from each other, so a group key
 * and an item row id that happen to be equal do not name one row twice.
 *
 * It is NOT what keeps an after-row apart from a caller's row: nothing reserves
 * this prefix from `getRowId`, so a data row could carry the same id. The
 * separation that has to hold — one roving-tabindex key, one cell — is
 * structural instead, in `buildAfterRowCellKey`'s own key domain.
 */
const AFTER_ROW_ID_PREFIX = "__grid-after__";

/** The single row following an ungrouped body's items (`renderAfterRows`). */
export const AFTER_ROWS_ROW_ID = `${AFTER_ROW_ID_PREFIX}rows`;

export function buildAfterGroupRowId(groupKey: string): string {
  return `${AFTER_ROW_ID_PREFIX}group:${groupKey}`;
}

export function buildAfterItemRowId(itemRowId: string): string {
  return `${AFTER_ROW_ID_PREFIX}item:${itemRowId}`;
}

/**
 * The roving-tabindex key of an after-row's single cell. An after-row paints one
 * cell — its affordance — and leaves the rest of the tracks to the presentation
 * layer, so there is exactly one key per row.
 */
export function buildAfterRowCellKeys(rowId: string): string[] {
  return [buildAfterRowCellKey(rowId, LEAD_CELL_COLUMN_KEY)];
}

/**
 * The grid's keyboard entry point: the first cell of the first rendered DATA
 * row, falling back to the first after-row slot's own first cell when the body
 * has no data rows at all — a table whose only row is its create row still has
 * to be reachable by Tab.
 */
export function buildFirstCellKey(
  firstItemRowId: string | undefined,
  firstColumnKey: string,
  firstAfterRowId: string | undefined
): string | null {
  if (firstItemRowId !== undefined) {
    return buildCellKey(firstItemRowId, firstColumnKey);
  }
  if (firstAfterRowId !== undefined) {
    return buildAfterRowCellKey(firstAfterRowId, LEAD_CELL_COLUMN_KEY);
  }
  return null;
}

export type ResolvedAfterRows = {
  /** Node per open group key, present only where the slot produced one. */
  groupNodes: Map<string, ReactNode>;
  /** Node per rendered item's row id, same. */
  itemNodes: Map<string, ReactNode>;
  /** The ungrouped body's trailing node, or null. */
  rowsNode: ReactNode;
  /**
   * Row ids of the slots that produced a node. Order is meaningful for the
   * FIRST element only — the grid's keyboard entry point when the body has no
   * data rows at all; an after-item id can never lead, because a slot following
   * an item exists only when the grid painted one.
   */
  ids: string[];
};

/**
 * Evaluate every after-row slot ONCE, so what the grid registers is what the
 * slot actually PRODUCED rather than merely that a slot was wired.
 *
 * The distinction is the roving tabindex's staleness guard. `renderAfterItem`
 * is a conditional slot — callers return a node for one row and `null` for the
 * rest — so registering a key per rendered ITEM would leave a key live after
 * its row stopped painting. The remembered active cell would keep matching a
 * cell nothing renders, no other cell would match either, and the whole grid
 * would go `tabIndex={-1}` and drop out of the tab order: exactly the failure
 * that guard exists to prevent.
 */
export function resolveAfterRows<T>({
  collapsedGroups,
  getRowId,
  groups,
  renderAfterGroup,
  renderAfterItem,
  renderAfterRows,
  renderedItems,
}: {
  collapsedGroups: ReadonlySet<string>;
  getRowId: (item: T) => string;
  groups?: readonly GridTableV2Group<T>[];
  renderAfterGroup?: (group: GridTableV2Group<T>) => ReactNode;
  renderAfterItem?: (item: T) => ReactNode;
  renderAfterRows?: ReactNode;
  renderedItems: readonly T[];
}): ResolvedAfterRows {
  const groupNodes = new Map<string, ReactNode>();
  const itemNodes = new Map<string, ReactNode>();
  const ids: string[] = [];
  if (groups && renderAfterGroup) {
    for (const group of groups) {
      if (collapsedGroups.has(group.key)) {
        continue;
      }
      const node = renderAfterGroup(group);
      if (isPaintedNode(node)) {
        groupNodes.set(group.key, node);
        ids.push(buildAfterGroupRowId(group.key));
      }
    }
  }
  const rowsNode = groups || !isPaintedNode(renderAfterRows) ? null : renderAfterRows;
  if (rowsNode !== null) {
    ids.push(AFTER_ROWS_ROW_ID);
  }
  if (renderAfterItem) {
    for (const item of renderedItems) {
      const node = renderAfterItem(item);
      if (isPaintedNode(node)) {
        itemNodes.set(getRowId(item), node);
        ids.push(buildAfterItemRowId(getRowId(item)));
      }
    }
  }
  return { groupNodes, ids, itemNodes, rowsNode };
}

/**
 * Whether a slot returned something React will actually paint.
 *
 * `null` is not the only way a slot declines. React renders NOTHING for `true`
 * as well as `false`, for an empty string, for an empty array, and for a
 * fragment with no painted children — and each of those reaching the registry
 * costs the same as the bug the registry exists to prevent: a key live for a row
 * nothing renders, which no rendered cell can match, so every cell in the grid
 * falls to `tabIndex={-1}` and the grid leaves the tab order. The check is
 * therefore what React paints, not what is merely non-null.
 *
 * A non-array iterable is left painted rather than walked: consuming one here
 * would exhaust the iterator the render then needs.
 */
function isPaintedNode(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === "boolean") {
    return false;
  }
  if (typeof node === "string") {
    return node.length > 0;
  }
  if (Array.isArray(node)) {
    return node.some((child: ReactNode) => isPaintedNode(child));
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return node.type === Fragment ? isPaintedNode(node.props.children) : true;
  }
  return true;
}
