"use client";

import {
  ColumnMoveDirection,
  ColumnResizeDirection,
  clampColumnWidth,
  moveColumn,
  moveColumnByDirection,
  resizeColumnByDirection,
} from "@closedloop-ai/design-system/lib/column-order";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import type { DragEvent, KeyboardEvent, PointerEvent } from "react";
import type {
  TableGridHeaderReorder,
  TableGridHeaderResize,
} from "./table-grid-header";

/**
 * The reorder and resize GRIPS a `TableGridHeader` data column can grow, plus
 * the pointer/keyboard handlers that drive them.
 *
 * Split out of `table-grid-header.tsx` (ISS-5333) rather than piled on: that
 * file was at 996 lines against the repo's 1,000-line ceiling, and these two
 * grips are one cohesive concern — direct manipulation of a column's POSITION
 * and WIDTH — with no dependency on the header's sort/tooltip/menu rendering.
 * The header keeps deciding WHEN a grip renders (`canReorder` / `canResize`);
 * this module owns what each grip is and how it responds.
 */

// `dataTransfer` key carrying the dragged column id across the DnD lifecycle.
export const COLUMN_DRAG_DATA_TYPE = "text/x-grid-table-column";

/**
 * Keyboard drag handle plus the VISUAL reorder affordance for a reorderable
 * column header. It is deliberately NOT the pointer target: the whole header
 * cell is (`draggable` in `TableGridHeaderCell`), which is why this costs the
 * grid no horizontal room at all.
 *
 * ISS-5812 — why this is `pointer-events-none` and back in the divider seam.
 * FEA-4158 reserved a gutter for the grip; ISS-5356 removed it, then put it
 * back as a real 36px lane (`pl-9`) on the header cell AND every data cell of
 * every reorderable column. That lane was the bug: the columns a product
 * actually reorders are all of them, so every cell in every grid paid 24px of
 * left padding for a control only the header row has.
 *
 * ISS-5356's underlying complaint was real and is still honoured. The previous
 * column's v2 resize strip (`ColumnResizeHandle`, `z-20`) reaches the divider,
 * above a grip's `z-auto`. So a seam-parked grip that WANTS THE POINTER has part
 * of its hit box operating the neighbour, and no amount of z-fighting fixes it —
 * raising the grip over the strip only trades the bug for an unresizable
 * divider, since the pointer at the divider is inside THIS cell and reveals THIS
 * grip.
 *
 * The way out is to stop making the glyph the pointer target. Reorder is driven
 * by dragging the header cell itself — a target the size of the column
 * (>= `MIN_COLUMN_WIDTH_PX` x `h-10`), which is an order of magnitude larger
 * than the 24px box the lane was bought to hold. With no pointer claim left, the
 * glyph is free to sit in the seam again: it cannot be shadowed by the resize
 * strip, cannot steal the sort button's click, and cannot cost a single pixel of
 * layout. Keyboard reorder is unaffected — `pointer-events: none` does not
 * remove focusability, so this stays a real focusable button with an accessible
 * name and `ArrowLeft`/`ArrowRight` (WCAG 2.1.1 Keyboard).
 *
 * Placement: `-left-0.5` + `size-3.5` puts the glyph box at [-2, 12] in the
 * cell's padding-box coordinates (x=0 is the divider). The lucide grip paints
 * only the middle of its box, so the visible INK lands at [2.67, 7.33] — wholly
 * inside this column and clear of the label at x=12, with no reserved lane and
 * without the astride-the-divider look ISS-5356's design pass objected to.
 *
 * That ink is also clear of the neighbour's resize reach, which is a SEPARATE
 * requirement from the pointer-events one above and is met on the strip's side
 * (`ColumnResizeHandle`, `-right-px`). `pointer-events-none` guarantees the grip
 * never STEALS a press; it does nothing about a press LANDING somewhere else,
 * and while the strip straddled the divider the first half of these dots sat
 * under it at `z-20` — the user grabbed the visible reorder cue and resized the
 * previous column. A cue that does not do what it depicts is a defect whether or
 * not the cue itself handled the event, so the two extents are pinned against
 * each other in `grid-table-reorder.test.tsx` rather than each in isolation.
 */
export function ColumnDragHandle({
  columnId,
  label,
  reorder,
}: {
  columnId: string;
  label: string;
  reorder: TableGridHeaderReorder;
}) {
  return (
    <button
      // Operation is in the name so a screen-reader user knows the arrow keys
      // reorder (WCAG 2.1.1 / 4.1.2), not just that a "Reorder" control exists.
      aria-label={`Reorder ${label} column, use arrow keys`}
      // `pointer-events-none` is load-bearing, not decoration: it is what lets
      // the glyph sit in the seam without fighting the neighbour's resize strip
      // for the pointer, and what guarantees the invisible-at-rest glyph can
      // never swallow a click meant for the sort button. The pointer drag lives
      // on the header cell; see the module note above.
      className={cn(
        "-translate-y-1/2 -left-0.5 pointer-events-none absolute top-1/2 flex size-3.5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity",
        // `ring-inset` is required, not cosmetic: without it the 2px ring paints
        // OUTSIDE the 14px box, i.e. across [-4, 14] — over the label's first
        // character on one side and past the divider into the previous column on
        // the other. Focus-visible is the ONLY state a keyboard user ever sees
        // this control in, so it has to respect the same bounds the resting
        // glyph does.
        "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/header:opacity-100"
      )}
      onKeyDown={(event) => handleReorderKeyDown(event, columnId, reorder)}
      type="button"
    >
      <GripVerticalIcon className="size-3.5" />
    </button>
  );
}

/**
 * Start a column drag from the header cell itself (ISS-5812). Writes the same
 * `dataTransfer` payload the drop handler reads, so the drag contract is
 * unchanged — only the element the user grabs is.
 */
export function startColumnDrag(
  event: DragEvent<HTMLDivElement>,
  columnId: string
): boolean {
  // A real browser always attaches `dataTransfer` to a dragstart, but a
  // synthetic one need not. Reported so the caller can skip the drag's visual
  // state too, rather than advertising a drag that carries no payload — and so
  // the same absence is handled the same way in all three drag handlers here
  // (`handleColumnDrop` and the header's `dragenter` read it as well; guarding
  // only one of the three left the other two throwing on the very input this
  // exists for).
  if (!event.dataTransfer) {
    return false;
  }
  event.dataTransfer.setData(COLUMN_DRAG_DATA_TYPE, columnId);
  event.dataTransfer.effectAllowed = "move";
  return true;
}

/** Whether `event` carries a column-drag payload; false when `dataTransfer` is absent. */
export function isColumnDragEvent(event: DragEvent<HTMLDivElement>): boolean {
  return event.dataTransfer?.types.includes(COLUMN_DRAG_DATA_TYPE) === true;
}

// Read the dragged column id and move it before the drop-target column.
export function handleColumnDrop(
  event: DragEvent<HTMLDivElement>,
  reorder: TableGridHeaderReorder,
  targetColumnId: string
) {
  event.preventDefault();
  const draggedId =
    event.dataTransfer?.getData(COLUMN_DRAG_DATA_TYPE) ?? "";
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

// Arrow-key reorder for a focused drag handle. `preventDefault` stops the arrow
// key from ALSO horizontally scrolling the table's scroll container, so the
// header does not jump sideways on every reorder keypress.
function handleReorderKeyDown(
  event: KeyboardEvent<HTMLButtonElement>,
  columnId: string,
  reorder: TableGridHeaderReorder
) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    reorder.onReorder(
      moveColumnByDirection(reorder.columnOrder, columnId, ColumnMoveDirection.Left)
    );
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    reorder.onReorder(
      moveColumnByDirection(reorder.columnOrder, columnId, ColumnMoveDirection.Right)
    );
  }
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
 */
export function ColumnResizeHandle({
  columnId,
  label,
  resize,
  enhancedHeaderInteractions,
}: {
  columnId: string;
  label: string;
  resize: TableGridHeaderResize;
  /** See `TableGridHeaderProps.enhancedHeaderInteractions`. */
  enhancedHeaderInteractions: boolean;
}) {
  if (!enhancedHeaderInteractions) {
    // Pre-v2 handle, kept verbatim for every table that has not opted in
    // (Branches wires resize on web and desktop today). Reveal on header hover
    // or keyboard focus, with a visible on-token divider bar inside the strip.
    return (
      <button
        aria-label={`Resize ${label} column, use arrow keys`}
        className={cn(
          "absolute top-0 right-0 z-10 flex h-full w-1.5 cursor-col-resize touch-none items-center justify-center opacity-0 transition-opacity",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/header:opacity-100"
        )}
        data-no-column-drag
        draggable={false}
        onKeyDown={(event) => handleResizeKeyDown(event, columnId, resize)}
        onPointerDown={(event) =>
          handleResizePointerDown(event, columnId, resize)
        }
        type="button"
      >
        <span aria-hidden className="h-4 w-px rounded-full bg-border" />
      </button>
    );
  }
  return (
    <button
      // Operation is in the name so a screen-reader user knows the arrow keys
      // resize (WCAG 2.1.1 / 4.1.2), not just that a "Resize" control exists.
      aria-label={`Resize ${label} column, use arrow keys`}
      // Criterion 5, lifted from the prototype: the HIT AREA and the VISUAL are
      // decoupled. The button is a 12px strip reaching back from the column
      // divider (`-right-px w-3`) so the pointer does not have to find a 1px
      // border, while what the user SEES is the `after:` hairline.
      //
      // ISS-5812 (wongk review) is why the strip reaches BACK rather than
      // straddling. `-right-1.5` centred the 12px box on the divider, so it hung
      // 6px past this cell's padding box — 5px into the NEXT column's padding
      // box, once that column's 1px `border-l` is taken off. The next column's
      // reorder grip paints its ink at [2.67, 7.33] there, so at `z-20` this
      // strip covered the first half of those dots: pressing the visible grip
      // resized THIS column instead of starting the neighbour's header drag.
      // `pointer-events-none` on the grip could not fix that — it is what lets
      // the press through to the strip in the first place. The two affordances
      // simply cannot both own the same 5px, so the seam is split: resize takes
      // everything up to and including the divider, reorder takes the gutter
      // beyond it.
      //
      // `-right-px` + `justify-end` is what splits it without shrinking either.
      // The box becomes [-11, +1] in this cell's padding-box coordinates, so its
      // right edge lands on the far side of the next column's 1px border — i.e.
      // exactly x=0 in that column's padding box, clear of the ink at 2.67 by
      // the full 2.67px. The hit area is still the same 12px (criterion 5 is
      // about SIZE, not symmetry), and `justify-end` re-pins the hairline to the
      // divider it marks: flex-centring it in a box that no longer centres on
      // the divider would have slid the visible cue 5px into the column.
      //
      // The hairline's reveal is scoped to the HEADER, not the strip: at rest
      // it is invisible, hovering anywhere on the column shows it faintly (so
      // the affordance still announces itself — "this column resizes" — the way
      // the pre-v2 handle did), and it firms up to 70% once the pointer is
      // actually inside the strip, then full on keyboard focus and while
      // dragging. Revealing only inside the 12px strip would have turned a
      // discoverable affordance into one you have to already know about.
      // `touch-none` lets the pointer capture own the horizontal drag instead of
      // the browser scrolling the container.
      className={cn(
        "-right-px absolute top-0 z-20 flex h-full w-3 cursor-col-resize touch-none items-center justify-end outline-none",
        "after:h-full after:w-px after:bg-primary after:opacity-0 after:transition-opacity after:duration-100",
        "group-hover/header:after:opacity-40 hover:after:opacity-70 focus-visible:after:opacity-100 active:after:opacity-100"
      )}
      // ISS-5812: `draggable={false}` here does NOT stop a drag — the HTML drag
      // model walks UP to the nearest `draggable` ancestor, which is the header
      // cell. What actually protects the strip is `handleResizePointerDown`
      // calling `preventDefault()` on pointerdown, which suppresses the drag
      // initiation. Do not delete that call. `draggable={false}` is kept only so
      // the strip itself is never the drag source.
      data-no-column-drag
      draggable={false}
      onKeyDown={(event) => handleResizeKeyDown(event, columnId, resize)}
      onPointerDown={(event) => handleResizePointerDown(event, columnId, resize)}
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
  resize: TableGridHeaderResize
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
  // Criterion 5: hold the col-resize cursor for the WHOLE drag, not just while
  // the pointer is over the 12px handle — otherwise the cursor flickers back to
  // the default the instant the drag outruns the handle, which is most of the
  // drag. Restore the PREVIOUS value rather than clearing to "": a host that had
  // set its own body cursor (a drag-and-drop surface mid-operation) would
  // otherwise silently lose it when a column resize ends.
  const previousCursor = globalThis.document.body.style.cursor;
  const previousUserSelect = globalThis.document.body.style.userSelect;
  globalThis.document.body.style.cursor = "col-resize";
  // Without this a fast drag selects the header labels it passes over.
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
  resize: TableGridHeaderResize
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
