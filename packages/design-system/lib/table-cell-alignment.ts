"use client";

/**
 * How a data cell tells the value primitive inside it which end of the track the
 * COLUMN asked for — ISS-9821.
 *
 * A grid renders through one table-level `renderCell(columnId, item)`, so the
 * node that carries a value is built by the HOST and the grid never sees its
 * props. `TableNumberCell` right-aligns itself with `ml-auto`, which eats the
 * free space a cell's `justify-end` would otherwise distribute — so the cell's
 * justification is inert over a canonical Number cell, and a column declaring
 * `align: Start` rendered a start-aligned HEADER over a right-aligned VALUE.
 * Context is the only channel that reaches inside a host-built node without
 * every host passing the column's alignment down by hand.
 *
 * `null` — the default, and every consumer outside a grid data cell — means NO
 * column stated an alignment, and each primitive keeps its own default. That is
 * what makes this additive: a table whose columns declare nothing renders
 * exactly as it did.
 */

import { createContext, useContext } from "react";

/**
 * The `alignEnd` the enclosing column asked for, or `null` when it asked for
 * nothing. A boolean rather than a `ColumnAlignment` because a primitive has no
 * column to reason about — it is handed an answer, not a declaration — and
 * because a three-value alignment would put the End/not-End decision in every
 * primitive instead of in `resolveCellAlignEnd` (`column-cell-alignment.ts`),
 * which is also why the registry-aware resolver is not in this module: this one
 * is imported by the leaf value primitives and must stay off the registry.
 */
const TableCellAlignEndContext = createContext<boolean | null>(null);

export const TableCellAlignEndProvider = TableCellAlignEndContext.Provider;

/**
 * The alignment a value primitive renders at: the caller's own prop when it
 * states one, else the enclosing column's, else the primitive's own default.
 *
 * An explicit prop WINS over the column — a caller that wrote
 * `alignEnd={false}` on one cell (a duration under a numeric column, say) is
 * overriding the column on purpose and must keep doing so.
 */
export function useTableCellAlignEnd(
  declared: boolean | undefined,
  fallback: boolean
): boolean {
  const fromColumn = useContext(TableCellAlignEndContext);
  if (declared !== undefined) {
    return declared;
  }
  return fromColumn ?? fallback;
}
