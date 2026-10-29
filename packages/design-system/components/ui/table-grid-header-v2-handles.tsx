"use client";

import {
  ColumnResizeDirection,
  clampColumnWidth,
  MIN_COLUMN_WIDTH_PX,
  moveColumn,
  resizeColumnByDirection,
} from "@closedloop-ai/design-system/lib/column-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { DragEvent, KeyboardEvent, PointerEvent } from "react";
import type {
  TableGridHeaderV2Reorder,
  TableGridHeaderV2Resize,
} from "./table-grid-header-v2";

/**
 * The reorder DROP handling and the resize GRIP a `TableGridHeaderV2` data
 * column can grow, plus the pointer/keyboard handlers that drive them.
 *
 * Split out of `table-grid-header-v2.tsx` (ISS-8068) rather than piled on, and
 * deliberately the same seam ISS-5333 cut in the v1 twin: that file was at
 * 1,096 lines against the repo's 1,000-line ceiling, and direct manipulation of
 * a column's POSITION and WIDTH is one cohesive concern with no dependency on
 * the header's sort/tooltip/menu rendering. The header keeps deciding WHEN a
 * grip renders (`canReorder` / `canResize`); this module owns what each grip is
 * and how it responds.
 *
 * The type-only import back into the header mirrors `table-grid-header-handles`
 * and is erased at build time, so the cycle is a compile-time one only.
 */

// `dataTransfer` key carrying the dragged column id across the DnD lifecycle.
export const COLUMN_DRAG_DATA_TYPE = "text/x-grid-table-column";

// Read the dragged column id and move it before the drop-target column.
export function handleColumnDrop(
  event: DragEvent<HTMLDivElement>,
  reorder: TableGridHeaderV2Reorder,
  targetColumnId: string
) {
  event.preventDefault();
  const draggedId = event.dataTransfer.getData(COLUMN_DRAG_DATA_TYPE);
  if (!draggedId || draggedId === targetColumnId) {
    return;
  }
  const fromIndex = reorder.columnOrder.indexOf(draggedId);
  const toIndex = reorder.columnOrder.indexOf(targetColumnId);
  if (fromIndex === -1 || toIndex === -1) {
    return;
  }
  reorder.onReorder(moveColumn(reorder.columnOrder, fromIndex, toIndex));
}

/**
 * Keyboard-and-pointer-accessible resize handle pinned to a column header's
 * right edge (FEA-4168). Pointer: pressing captures the pointer and each move
 * sets the column width to its width-at-press plus the horizontal drag delta,
 * clamped to the shared floor. Keyboard: the handle is a focusable `button`
 * (accessible name via `aria-label`) whose `ArrowLeft`/`ArrowRight` shrink/grow
 * the column one step — the same clamp the drag uses — so a keyboard user
 * reaches every width without a pointer (WCAG 2.1.1 Keyboard). It reports the
 * final width via `resize.onResize`; the caller persists it and feeds the
 * current width back through `resize.getColumnWidth`.
 *
 * ISS-8068 — why this stays a `button` and not an APG window splitter, when
 * the repo does ship one. `BranchCommentsRail` IS a splitter: `role="separator"`
 * with `aria-valuenow`, `aria-valuemin` and a real `aria-valuemax`, because a
 * rail has a bounded travel to state a position inside. Read this as the edge of
 * that rule, not as "we do not do splitters here."
 *
 * A grid column has no such bound. Widths clamp to `MIN_COLUMN_WIDTH_PX` and
 * grow without a ceiling, so there is no honest `aria-valuemax` to publish, and
 * omitting it is worse than not adopting the pattern — ARIA defaults an absent
 * `aria-valuemax` to 100, which would make every column past 100px report a
 * position beyond its own maximum. Inventing a ceiling to satisfy the markup
 * would change what a drag can reach, which is a product decision this ticket
 * does not carry. A splitter is also the wrong SHAPE here even given a max: it
 * states a position between two panes sharing a total, so it announces a
 * proportion, while column resize is absolute pixels and pixels are what the
 * arrow keys move by. "68 percent" is not a useful thing to say about a 16px
 * nudge.
 *
 * So the width is stated where a button legitimately can state it: in the
 * accessible name, recomputed on every render from the same `getColumnWidth` the
 * arrow keys adjust.
 */
export function ColumnResizeHandle({
  columnId,
  label,
  resize,
}: {
  columnId: string;
  label: string;
  resize: TableGridHeaderV2Resize;
}) {
  return (
    <button
      aria-label={buildResizeHandleName(
        label,
        resize.getColumnWidth(columnId)
      )}
      // Center a forgiving 12px hit target over the divider while keeping the
      // visual affordance to a single line. This matches the reference: the
      // pointer does not have to land on a one-pixel border, but the resting table
      // still reads as a clean grid.
      className={cn(
        "absolute top-0 -right-1.5 z-20 flex h-full w-3 cursor-col-resize touch-none items-center justify-center outline-none",
        "after:h-full after:w-px after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-70 focus-visible:after:opacity-100 active:after:opacity-100"
      )}
      data-no-column-drag
      draggable={false}
      onKeyDown={(event) => handleResizeKeyDown(event, columnId, resize)}
      onPointerDown={(event) =>
        handleResizePointerDown(event, columnId, resize)
      }
      type="button"
    />
  );
}

// Pointer-drag resize: capture the pointer so moves keep tracking outside the
// thin handle, then set the width to width-at-press + horizontal delta (clamped).
// Live moves are coalesced to one commit per animation frame so a fast drag does
// not push a `resize.onResize` (and the caller's synchronous persistence) per
// raw pointermove; the final width is committed on pointerup/cancel. The drag is
// scoped to the initiating `pointerId` so a second concurrent touch cannot
// hijack it, and `lostpointercapture` tears the listeners down if capture is
// lost without a pointerup/pointercancel.
function handleResizePointerDown(
  event: PointerEvent<HTMLButtonElement>,
  columnId: string,
  resize: TableGridHeaderV2Resize
) {
  // Left button only; ignore secondary/middle so a context-menu press does not
  // start a phantom resize.
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const handle = event.currentTarget;
  const activePointerId = event.pointerId;
  const startX = event.clientX;
  const startWidth = resize.getColumnWidth(columnId);
  const previousCursor = globalThis.document.body.style.cursor;
  const previousUserSelect = globalThis.document.body.style.userSelect;
  globalThis.document.body.style.cursor = "col-resize";
  globalThis.document.body.style.userSelect = "none";
  handle.setPointerCapture(activePointerId);

  let frame: number | null = null;
  let pendingWidth = startWidth;

  const commit = () => {
    frame = null;
    resize.onResize(columnId, pendingWidth);
  };
  const onMove = (moveEvent: globalThis.PointerEvent) => {
    // Ignore events from any other pointer so a second touch cannot resize the
    // drag started by the first.
    if (moveEvent.pointerId !== activePointerId) {
      return;
    }
    pendingWidth = clampColumnWidth(startWidth + (moveEvent.clientX - startX));
    frame ??= globalThis.requestAnimationFrame(commit);
  };
  const teardown = () => {
    if (frame !== null) {
      globalThis.cancelAnimationFrame(frame);
      frame = null;
    }
    // Persist the final width once, even if the last move was still queued.
    resize.onResize(columnId, pendingWidth);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    handle.removeEventListener("lostpointercapture", teardown);
    globalThis.document.body.style.cursor = previousCursor;
    globalThis.document.body.style.userSelect = previousUserSelect;
  };
  // pointerup / pointercancel carry a pointerId, so only the initiating pointer
  // ends the drag; `lostpointercapture` always pertains to the captured pointer
  // and tears down unconditionally (the safety net if capture is lost without an
  // up/cancel).
  const onEnd = (endEvent: globalThis.PointerEvent) => {
    if (endEvent.pointerId !== activePointerId) {
      return;
    }
    teardown();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
  handle.addEventListener("lostpointercapture", teardown);
}

// Arrow-key resize for a focused resize handle. `preventDefault` stops the arrow
// key from ALSO horizontally scrolling the table's scroll container.
function handleResizeKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  columnId: string,
  resize: TableGridHeaderV2Resize
) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    resize.onResize(
      columnId,
      resizeColumnByDirection(
        resize.getColumnWidth(columnId),
        ColumnResizeDirection.Shrink
      )
    );
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    resize.onResize(
      columnId,
      resizeColumnByDirection(
        resize.getColumnWidth(columnId),
        ColumnResizeDirection.Grow
      )
    );
  }
}

/**
 * The resize handle's whole accessible name (ISS-8068).
 *
 * Operation AND current width belong in it: a screen-reader user needs to know
 * the arrow keys resize (WCAG 2.1.1 / 4.1.2) and what they are resizing FROM,
 * otherwise each keypress is an unmeasurable nudge. This is the whole name — an
 * `aria-label` shadows descendant text, so the button deliberately carries no
 * `sr-only` child restating a shorter version of it.
 *
 * A NON-FINITE width states no width at all. `getColumnWidth` is caller-owned
 * and typed `number`, which at runtime admits `NaN` and both infinities, and
 * `GridTableV2` hands the caller's `columnWidths` map to it unclamped — so a
 * corrupt persisted width from a restored saved view reaches this string
 * untouched. Interpolating one announces "NaN pixels wide", a confident
 * measurement that is simply false, which is exactly what the repo's
 * bad-data rule forbids emitting. Falling back to the operation-only name this
 * control carried before ISS-8068 tells the user what the keys do and tells
 * them nothing untrue. That fallback is deliberately the already-shipped
 * string rather than a new "width unavailable" phrase: declining to lie about a
 * corrupt value is an implementation call, inventing user-facing copy for it is
 * not.
 *
 * At the floor the control otherwise goes silent: ArrowLeft emits the width the
 * column already has, the host writes back the same state, nothing re-renders,
 * and the name does not change. A sighted user watches the column stop; a
 * screen-reader user gets nothing and cannot tell "at minimum" from "control
 * broken". Naming the floor is the one thing this button pattern does better
 * than a splitter carrying only an `aria-valuemin`.
 */
function buildResizeHandleName(label: string, widthPx: number): string {
  if (!Number.isFinite(widthPx)) {
    return `Resize ${label} column, use arrow keys`;
  }
  const widthPhrase =
    widthPx <= MIN_COLUMN_WIDTH_PX
      ? `${widthPx} pixels wide, minimum`
      : `${widthPx} pixels wide`;
  return `Resize ${label} column, ${widthPhrase}, use arrow keys`;
}
