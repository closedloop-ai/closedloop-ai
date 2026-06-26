/**
 * Shared layout class strings for the document table column cells
 * (FEA-1763 / PLN-874). Centralizes the fixed-width cell box so the ~18
 * repetitions across edit-cells, static-cells, score-cell, and tags-cell
 * stay in sync.
 */

/** Standard cell box: fixed-width, vertically centered, left border. */
export const CELL_CLASSES =
  "flex h-full min-h-11 w-[124px] shrink-0 items-center border-l px-3 py-2";

/**
 * Cell box for the two link cells that delegate padding/centering to an inner
 * `<Link>` — omits `flex items-center` and `px-3 py-2`.
 */
export const CELL_LINK_CLASSES = "h-full min-h-11 w-[124px] shrink-0 border-l";
