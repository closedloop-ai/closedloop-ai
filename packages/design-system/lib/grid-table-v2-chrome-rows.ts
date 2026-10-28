/**
 * `GridTableV2`'s CHROME rows — the column-header row and every group-section
 * header — as rows of the same roving focus model its data rows already use
 * (ISS-8930).
 *
 * ISS-8726 completed the APG single tab stop for the grid's DATA cells, and
 * deliberately stopped there: a `columnheader` and a group header carried no
 * `data-grid-cell` and no roving `tabIndex`, so their cells could not take
 * focus at all. Suppressing the sort control, the resize handle or the collapse
 * toggle inside them would then have left each with no keyboard route
 * whatsoever — a WCAG 2.1.1 dead end, strictly worse than the extra tab stop.
 * Making the cells navigable FIRST is what lets suppression reach them without
 * taking anything away.
 *
 * Chrome rows join by the same two structural facts a data row joins by, and
 * nothing else: `data-grid-row` puts the row in `resolveNextGridCell`'s row
 * walk, and `data-grid-cell` puts its cells in that row's cell walk. Because
 * that walk is DOCUMENT ORDER inside `[data-grid-body]`, the Up/Down
 * transitions across header, group header and data rows are not a second
 * traversal to keep in step with the render — they ARE the render's order.
 *
 * No React runtime and no DOM — the id and key vocabulary is unit-testable
 * without mounting a table, the reason its `grid-table-v2-rows` and
 * `grid-table-v2-after-row` siblings sit here too.
 */

import type { KeyboardEvent } from "react";
import type { GridCellNavigationProps } from "./grid-table-v2-after-row";
import {
  buildSubgroupKey,
  LEAD_CELL_COLUMN_KEY,
  UTILITY_CELL_COLUMN_KEY,
} from "./grid-table-v2-rows";
import type { GridTableV2Group } from "./grid-table-v2-types";

/**
 * The wiring that makes one chrome cell a navigable cell of the grid.
 *
 * Built ON `GridCellNavigationProps` rather than beside it: that type is the
 * roving-tabindex contract every navigable cell in this grid already shares,
 * and re-declaring its fields here is exactly the drift it exists to prevent —
 * a field added there has to be a type error on the header and the group
 * headers too, not only on the data and after-row cells.
 *
 * Undefined at a call site is the CLOSED flag, and spreading it is a no-op, so
 * a grid that has not opted in emits exactly the markup it always did.
 */
export type GridChromeCellProps = GridCellNavigationProps & {
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

/**
 * Focus affordance a chrome cell needs once it can hold focus at all. One
 * constant for the column-header cells and the group-section header cells,
 * because a ring tweaked on one and not the other would leave the same feature
 * indicating focus two different ways.
 */
export const NAVIGABLE_CHROME_CELL_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The same, for the row element the chrome cells sit in. */
export type GridChromeRowProps = {
  "data-grid-row": "";
  "data-grid-row-id": string;
};

/** The row-level markup a chrome row carries once it joins the row walk. */
export function buildChromeRowProps(rowId: string): GridChromeRowProps {
  return { "data-grid-row": "", "data-grid-row-id": rowId };
}

/**
 * Namespace keeping the chrome rows' ids apart from each other and from the
 * after-row slots'. Like that module's prefix, it is NOT what keeps a chrome
 * row apart from a caller's data row — nothing reserves it from `getRowId`.
 * That separation is structural, in `buildChromeCellKey`'s own key domain.
 */
const CHROME_ROW_ID_PREFIX = "__grid-chrome__";

/** The single column-header row, which every band shares. */
export const HEADER_ROW_ID = `${CHROME_ROW_ID_PREFIX}header`;

/**
 * Whether a `data-grid-row-id` belongs to a CHROME row rather than a caller's
 * data row.
 *
 * Exported because chrome rows now carry `data-grid-row-id` too, so every
 * consumer that reads that attribute to enumerate "the rows this render
 * painted" — the Storybook play helpers, a future host — silently started
 * counting the header and each band header among them the moment
 * `navigableHeaderCells` opened. Each such reader needs this test, and the
 * alternative is each one re-declaring the prefix, which is exactly the drift
 * keeping the prefix private was meant to prevent.
 */
export function isGridChromeRowId(rowId: string): boolean {
  return rowId.startsWith(CHROME_ROW_ID_PREFIX);
}

/**
 * A group's (or subgroup's) header row. Keyed by the SAME string the body
 * collapses that band under, so a subgroup's header row id is derived from
 * `buildSubgroupKey` rather than from its own bare key — two subgroups of
 * different parents may share a key, and two rows answering to one id would be
 * two cells at `tabIndex={0}`.
 */
export function buildGroupHeaderRowId(bandKey: string): string {
  return `${CHROME_ROW_ID_PREFIX}group:${bandKey}`;
}

/**
 * Column-key stand-in for a group header's single cell. It spans every track
 * (`aria-colspan`), so unlike a data row there is exactly one key per row.
 */
export const GROUP_HEADER_COLUMN_KEY = "__group__";

/**
 * Column-key stand-in for the caller-owned trailing header slot — the Add-field
 * control on the Sessions grid.
 *
 * It used to be excluded, on the reasoning that the body paints no navigable
 * counterpart for that track. That was true and beside the point (whitlockk review):
 * excluding it did not make the trailing control unreachable, it made it
 * reachable ONLY by Tab. The slot kept a native tab stop that
 * `suppressGridCellTabStops` could not see — suppression walks up to the nearest
 * `[data-grid-cell]`, and a slot outside the walk has none — so the grid stayed
 * TWO tab stops with both gates open while the arrows never reached the control
 * at all. Including it is what makes the single-tab-stop model true.
 *
 * The asymmetry with the body is already handled and is not new here:
 * `resolveNextGridCell` resolves a row-wise move by logical column and falls
 * back to the destination row's last cell when the column has no counterpart,
 * which is the same path an after-row slot's short row has taken since ISS-8219.
 */
export const TRAILING_HEADER_COLUMN_KEY = "__trailing__";

/**
 * The column keys the header row's navigable cells take, in visible order.
 */
export function buildHeaderCellColumnKeys(
  dataColumnIds: readonly string[],
  hasLeadingUtilityCell: boolean,
  hasTrailingHeaderCell = false
): string[] {
  const columnKeys = [LEAD_CELL_COLUMN_KEY, ...dataColumnIds];
  if (hasLeadingUtilityCell) {
    columnKeys.unshift(UTILITY_CELL_COLUMN_KEY);
  }
  if (hasTrailingHeaderCell) {
    columnKeys.push(TRAILING_HEADER_COLUMN_KEY);
  }
  return columnKeys;
}

/**
 * The group-header row ids one grouped render actually paints, in visible
 * order.
 *
 * Mirrors the body render exactly, and the two branches are not symmetric: a
 * group's OWN header paints whether the group is open or closed (it is the
 * control that reopens it), while a subgroup's header paints only inside an
 * open parent. Registering a key for a header that did not paint is the
 * staleness bug the roving tabindex's fallback exists to prevent.
 */
export function collectGroupHeaderRowIds<T>(
  groups: readonly GridTableV2Group<T>[],
  collapsedGroups: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    ids.push(buildGroupHeaderRowId(group.key));
    if (collapsedGroups.has(group.key) || !group.subgroups) {
      continue;
    }
    for (const subgroup of group.subgroups) {
      ids.push(buildGroupHeaderRowId(buildSubgroupKey(group.key, subgroup.key)));
    }
  }
  return ids;
}
