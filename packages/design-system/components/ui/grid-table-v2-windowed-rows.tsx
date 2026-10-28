"use client";

/**
 * The body a `GridTableV2` paints once it windows its rows (ISS-12288): the
 * window's slice, the one row outside it the roving tab stop names, and the
 * spacers standing in for everything unpainted.
 *
 * Lifted out of `grid-table-v2.tsx` with its focus model (marisolashgrove review),
 * which holds that file under the growth its own windowing opt-in caused.
 *
 * A plain function rather than a component: it owns no state and no hooks, and
 * the rows it emits must be DIRECT children of the `role="grid"` element — a
 * component would be transparent to React but is one more indirection for a
 * reader checking that a `grid` owns only rows and rowgroups.
 */

import type { GridRowPaintPlan } from "@closedloop-ai/design-system/lib/grid-row-window";
import type { GridRenderRow } from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type { ReactNode } from "react";

/**
 * Anchors for the stand-ins a windowed body paints in place of the rows outside
 * what it painted (ISS-12288).
 *
 * They carry a handle for the same reason the list surface's bands do: the claim
 * is that the unpainted rows' height is still THERE, so the scrollbar and the
 * scroll offset are an unwindowed body's — and no assertion about the rows
 * inside can witness the height of a row that was not painted.
 */
export const GRID_ROW_SPACER_LEADING = "leading";
export const GRID_ROW_SPACER_TRAILING = "trailing";
/** Between a retained row and the window's slice; see {@link GridRowPaintPlan}. */
export const GRID_ROW_SPACER_GAP = "gap";

export function renderGridTableV2WindowedRows<T>({
  attachRowsSpacer,
  ariaRowIndexOffset,
  plan,
  renderRow,
  rows,
}: {
  attachRowsSpacer: (node: HTMLDivElement | null) => void;
  /**
   * Rows of the grid that precede the data rows — the column header — so a data
   * row's `aria-rowindex` is its position in the WHOLE table, which is the only
   * position a reader of a windowed grid can be given.
   */
  ariaRowIndexOffset: number;
  plan: GridRowPaintPlan;
  renderRow: (row: GridRenderRow<T>, ariaRowIndex: number) => ReactNode;
  rows: readonly GridRenderRow<T>[];
}): ReactNode {
  const paint = (index: number): ReactNode => {
    const row = rows[index];
    // `index + 1` because `aria-rowindex` is 1-based.
    return row === undefined
      ? null
      : renderRow(row, ariaRowIndexOffset + index + 1);
  };
  // ONE keyed array, rather than a slot per segment, and that is load-bearing:
  // React reconciles an array by key, so the row the roving tab stop names KEEPS
  // its DOM node and its React state as the window moves past it — including any
  // popover open inside it. Split across static slots, the same row would be
  // unmounted from one slot and remounted in another, which is the tear-down the
  // retention exists to prevent. `renderRow` puts the row id on each row, and the
  // gap spacer carries a key of its own for the same reason.
  const painted: ReactNode[] = [];
  if (plan.leadingRetainedIndex !== null) {
    painted.push(paint(plan.leadingRetainedIndex));
  }
  if (plan.gapPadPx > 0 && plan.trailingRetainedIndex === null) {
    painted.push(
      <GridRowSpacer
        heightPx={plan.gapPadPx}
        key={GRID_ROW_SPACER_GAP}
        spacer={GRID_ROW_SPACER_GAP}
      />
    );
  }
  for (let index = plan.startIndex; index < plan.endIndex; index += 1) {
    painted.push(paint(index));
  }
  if (plan.trailingRetainedIndex !== null) {
    if (plan.gapPadPx > 0) {
      painted.push(
        <GridRowSpacer
          heightPx={plan.gapPadPx}
          key={GRID_ROW_SPACER_GAP}
          spacer={GRID_ROW_SPACER_GAP}
        />
      );
    }
    painted.push(paint(plan.trailingRetainedIndex));
  }
  return (
    <>
      {/* The leading spacer always renders: it is also the anchor the window is
        measured from, and the sticky inset is read off ITS preceding siblings,
        so a conditional one would leave the measurement with nothing to find. */}
      <GridRowSpacer
        heightPx={plan.leadingPadPx}
        ref={attachRowsSpacer}
        spacer={GRID_ROW_SPACER_LEADING}
      />
      {painted}
      {plan.trailingPadPx > 0 ? (
        <GridRowSpacer
          heightPx={plan.trailingPadPx}
          spacer={GRID_ROW_SPACER_TRAILING}
        />
      ) : null}
    </>
  );
}

/**
 * One stand-in. `aria-hidden` is what keeps it out of the accessibility tree,
 * where a `grid` may own only rows and rowgroups.
 */
function GridRowSpacer({
  heightPx,
  ref,
  spacer,
}: {
  heightPx: number;
  ref?: (node: HTMLDivElement | null) => void;
  spacer: string;
}) {
  return (
    <div
      aria-hidden
      data-grid-row-spacer={spacer}
      ref={ref}
      style={{ height: heightPx }}
    />
  );
}
