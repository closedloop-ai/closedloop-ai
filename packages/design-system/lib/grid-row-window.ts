/**
 * Which rows of a grid body are worth painting at a given scroll offset
 * (ISS-12288), as arithmetic with no DOM and no React.
 *
 * Uniform row height is why this is arithmetic rather than a measurement loop:
 * a row's position is its index times that height. A body whose rows can differ
 * in height has no such closed form and must not use this module —
 * `GridTableV2` gates its opt-in on exactly that.
 *
 * That height is MEASURED and passed in, never assumed. `h-11` is `2.75rem`,
 * which is 44px only while the root font size is the 16px default; a constant
 * would drift the pads against the real content height for any reader who has
 * changed it.
 *
 * The invariant every function here holds: an unmeasured viewport yields the
 * WHOLE population. Windowing is an optimisation, and a layout this module
 * cannot measure must never be the reason a row stops rendering — the same rule
 * `useContainerWidth` applies to a zero-width box.
 */

/** `h-11` at the default root font size: the fallback, not the answer. */
export const GRID_TABLE_ROW_HEIGHT_PX = 44;

/** Floor for the overscan band; {@link resolveOverscanRows} sets its real size. */
export const GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS = 8;

/** The contiguous slice of a row population a scroll offset makes worth painting. */
export type GridRowWindow = {
  /** First painted index. */
  startIndex: number;
  /** One past the last painted index. */
  endIndex: number;
  /** Height standing in for the rows before {@link startIndex}. */
  leadingPadPx: number;
  /** Height standing in for the rows from {@link endIndex} on. */
  trailingPadPx: number;
};

/** What a viewport this module cannot measure resolves to: every row. */
export function wholeGridRowPopulation(rowCount: number): GridRowWindow {
  const count = toRowCount(rowCount);
  return {
    startIndex: 0,
    endIndex: count,
    leadingPadPx: 0,
    trailingPadPx: 0,
  };
}

/**
 * The window a scroll offset makes worth painting, or the whole population when
 * the viewport is not a real measurement (SSR, a detached or `display:none`
 * container, a host that owns no scroller).
 *
 * `rowsOffsetPx` is where row 0 begins inside the scroller's content — the
 * sticky header and whatever the host wraps the grid in sit above it, so a
 * caller that passes 0 for a grid with a header selects a window about one row
 * too far down.
 *
 * The sticky inset is deliberately NOT subtracted here, though
 * {@link resolveGridRowScrollTop} does subtract it. A window is a paint set with
 * slack in it, and the overscan absorbs an error of well under one row; a scroll
 * LANDING has no slack, because the reader either sees the row it moved to or
 * does not.
 */
export function resolveGridRowWindow({
  overscanRows,
  rowCount,
  rowHeightPx = GRID_TABLE_ROW_HEIGHT_PX,
  rowsOffsetPx = 0,
  scrollTop,
  viewportHeightPx,
}: {
  /** Rows kept painted past each edge. Default: one viewport's worth. */
  overscanRows?: number;
  rowCount: number;
  rowHeightPx?: number;
  rowsOffsetPx?: number;
  scrollTop: number;
  viewportHeightPx: number;
}): GridRowWindow {
  const count = toRowCount(rowCount);
  const rowHeight = toPositiveLength(rowHeightPx);
  const viewportHeight = toPositiveLength(viewportHeightPx);
  if (count === 0 || rowHeight === null || viewportHeight === null) {
    return wholeGridRowPopulation(count);
  }
  const offsetIntoRows =
    toNonNegativeLength(scrollTop) - toNonNegativeLength(rowsOffsetPx);
  const firstVisible = Math.floor(Math.max(0, offsetIntoRows) / rowHeight);
  // One more than the viewport divides into: a scroll offset that is not row
  // aligned leaves a partial row at the top AND at the bottom, and `ceil`
  // accounts for only one of them.
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;
  const overscan = resolveOverscanRows(overscanRows, visibleRows);
  const startIndex = clampIndex(firstVisible - overscan, count);
  const endIndex = Math.max(
    startIndex,
    clampIndex(firstVisible + visibleRows + overscan, count)
  );
  return {
    startIndex,
    endIndex,
    leadingPadPx: startIndex * rowHeight,
    trailingPadPx: (count - endIndex) * rowHeight,
  };
}

/**
 * The scroll offset that brings a row fully into view, or `null` when it already
 * is — and `null` for a viewport this module cannot measure, because a scroll
 * computed against a guessed height lands somewhere the reader did not ask for.
 *
 * `stickyInsetPx` is how much of the scroller's top edge the body's own sticky
 * chrome covers. Without it the leading branch lands the destination row's top
 * flush with the SCROLLER's top, which is where the sticky header is pinned —
 * so a reader arrowing up off the window, or pressing `Ctrl+Home`, lands on a
 * row they can only see the bottom sliver of.
 */
export function resolveGridRowScrollTop({
  index,
  rowCount,
  rowHeightPx = GRID_TABLE_ROW_HEIGHT_PX,
  rowsOffsetPx = 0,
  scrollTop,
  stickyInsetPx = 0,
  viewportHeightPx,
}: {
  index: number;
  rowCount: number;
  rowHeightPx?: number;
  rowsOffsetPx?: number;
  scrollTop: number;
  stickyInsetPx?: number;
  viewportHeightPx: number;
}): number | null {
  const count = toRowCount(rowCount);
  const rowHeight = toPositiveLength(rowHeightPx);
  const viewportHeight = toPositiveLength(viewportHeightPx);
  if (count === 0 || rowHeight === null || viewportHeight === null) {
    return null;
  }
  const offset = toNonNegativeLength(rowsOffsetPx);
  const stickyInset = toNonNegativeLength(stickyInsetPx);
  const currentTop = toNonNegativeLength(scrollTop);
  const rowTop = offset + clampIndex(index, count - 1) * rowHeight;
  // The region a reader can actually see starts BELOW the sticky chrome.
  if (rowTop < currentTop + stickyInset) {
    return Math.max(0, rowTop - stickyInset);
  }
  const rowBottom = rowTop + rowHeight;
  if (rowBottom > currentTop + viewportHeight) {
    return rowBottom - viewportHeight;
  }
  return null;
}

/**
 * The window the FIRST render paints, before any anchor exists to measure from.
 *
 * It does not break the whole-population rule above, because the layout effect
 * corrects it in the same commit: a layout effect runs before the browser
 * paints, so no reader sees the seed, and a layout that cannot be measured still
 * expands to every row. Only safe where that correction is guaranteed to run —
 * never on the server, where the seed would be the HTML the reader gets.
 */
export function seedGridRowWindow(rowCount: number): GridRowWindow {
  const count = toRowCount(rowCount);
  const endIndex = Math.min(count, GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS);
  return {
    startIndex: 0,
    endIndex,
    leadingPadPx: 0,
    trailingPadPx: (count - endIndex) * GRID_TABLE_ROW_HEIGHT_PX,
  };
}

/** Whether two windows select the same rows, so an equal one costs no render. */
export function isSameGridRowWindow(
  left: GridRowWindow,
  right: GridRowWindow
): boolean {
  return (
    left.startIndex === right.startIndex &&
    left.endIndex === right.endIndex &&
    left.leadingPadPx === right.leadingPadPx &&
    left.trailingPadPx === right.trailingPadPx
  );
}

/**
 * One viewport's worth each side by default, never below the floor.
 *
 * A fixed band is the wrong shape: it is the same number of rows whether the
 * reader is looking at 10 of them or 40, so on a tall viewport it is consumed
 * by a single flick. Scaling with the viewport makes the window change once per
 * viewport of travel instead.
 */
function resolveOverscanRows(
  overscanRows: number | undefined,
  visibleRows: number
): number {
  if (overscanRows === undefined) {
    return Math.max(GRID_ROW_WINDOW_MIN_OVERSCAN_ROWS, visibleRows);
  }
  return Math.max(0, Math.trunc(toNonNegativeLength(overscanRows)));
}

/** A row population: a whole, non-negative count, and never `NaN`. */
function toRowCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** A measured length, or `null` for every value that is not one. */
function toPositiveLength(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** A length that may legitimately be 0, with non-finite input read as 0. */
function toNonNegativeLength(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** An index held inside `[0, ceiling]`. */
function clampIndex(index: number, ceiling: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, ceiling));
}

/**
 * What a windowed body actually paints: the window's slice, plus the one row
 * outside it the roving tab stop names (ISS-12288, marisolashgrove review).
 *
 * Dropping that row is what let focus escape to `document.body` on a scroll —
 * and with it an open popover inside the row — so the next arrow key scrolled
 * the page instead of moving a cell. The retained row is painted in its own
 * document-order position, which is why there are up to THREE pads: the gap
 * stands in for the rows between the retained row and the slice, so the total
 * content height is still every row's.
 */
export type GridRowPaintPlan = {
  /** Height standing in for the rows before the first row painted. */
  leadingPadPx: number;
  /** The retained row painted before the slice, or `null`. */
  leadingRetainedIndex: number | null;
  /** Height standing in for the rows between the retained row and the slice. */
  gapPadPx: number;
  /** First index of the window's slice. */
  startIndex: number;
  /** One past the last index of the window's slice. */
  endIndex: number;
  /** The retained row painted after the slice, or `null`. */
  trailingRetainedIndex: number | null;
  /** Height standing in for the rows after the last row painted. */
  trailingPadPx: number;
};

/**
 * The paint plan for a window, retaining `retainedIndex` when it falls outside.
 *
 * A `retainedIndex` the window already covers, one outside the population, and
 * a window whose pads cannot yield a row height all resolve to the window
 * unchanged — the retention is an addition to the slice and must never be the
 * reason the geometry stops adding up.
 */
export function resolveGridRowPaintPlan({
  retainedIndex,
  rowCount,
  rowWindow,
}: {
  retainedIndex: number | null;
  rowCount: number;
  rowWindow: GridRowWindow;
}): GridRowPaintPlan {
  const count = toRowCount(rowCount);
  const plan: GridRowPaintPlan = {
    leadingPadPx: rowWindow.leadingPadPx,
    leadingRetainedIndex: null,
    gapPadPx: 0,
    startIndex: rowWindow.startIndex,
    endIndex: rowWindow.endIndex,
    trailingRetainedIndex: null,
    trailingPadPx: rowWindow.trailingPadPx,
  };
  if (
    retainedIndex === null ||
    !Number.isInteger(retainedIndex) ||
    retainedIndex < 0 ||
    retainedIndex >= count ||
    (retainedIndex >= rowWindow.startIndex && retainedIndex < rowWindow.endIndex)
  ) {
    return plan;
  }
  const rowHeight = inferRowHeightPx(rowWindow, count);
  if (rowHeight === null) {
    return plan;
  }
  if (retainedIndex < rowWindow.startIndex) {
    return {
      ...plan,
      leadingPadPx: retainedIndex * rowHeight,
      leadingRetainedIndex: retainedIndex,
      gapPadPx: (rowWindow.startIndex - retainedIndex - 1) * rowHeight,
    };
  }
  return {
    ...plan,
    gapPadPx: (retainedIndex - rowWindow.endIndex) * rowHeight,
    trailingRetainedIndex: retainedIndex,
    trailingPadPx: (count - retainedIndex - 1) * rowHeight,
  };
}

/**
 * The row height a window's pads were built from, read back off whichever pad
 * stands in for a non-empty run of rows.
 *
 * Read back rather than passed in so the retention arithmetic cannot be given a
 * height the pads beside it were not built from — a plan mixing two heights
 * reports a content height no row run has, which is the one thing the spacers
 * exist to get right. A window outside which no row sits has no pad to read,
 * and also no row to retain.
 */
function inferRowHeightPx(
  rowWindow: GridRowWindow,
  rowCount: number
): number | null {
  const height =
    rowWindow.startIndex > 0
      ? rowWindow.leadingPadPx / rowWindow.startIndex
      : rowWindow.trailingPadPx / Math.max(1, rowCount - rowWindow.endIndex);
  return toPositiveLength(height);
}

/**
 * The rows a windowed body paints: the window's slice, plus the retained row
 * the roving tab stop names when it falls outside (ISS-12288).
 *
 * In population order, which is what the roving-key registry and the keyboard
 * model both read it as — the retained row is painted in its own document-order
 * position too, so the order here is the order on screen.
 */
export function collectPaintedRows<R>(
  rows: readonly R[],
  plan: GridRowPaintPlan
): R[] {
  const indexes = [
    ...(plan.leadingRetainedIndex === null ? [] : [plan.leadingRetainedIndex]),
    ...Array.from(
      { length: Math.max(0, plan.endIndex - plan.startIndex) },
      (_unused, offset) => plan.startIndex + offset
    ),
    ...(plan.trailingRetainedIndex === null
      ? []
      : [plan.trailingRetainedIndex]),
  ];
  const painted: R[] = [];
  for (const index of indexes) {
    const row = rows[index];
    if (row) {
      painted.push(row);
    }
  }
  return painted;
}
