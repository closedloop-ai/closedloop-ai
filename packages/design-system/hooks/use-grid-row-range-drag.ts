"use client";

import {
  focusCellFromRowClick,
  GRID_BODY_SELECTOR,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { resolveDragRowIdAtPoint } from "@closedloop-ai/design-system/lib/grid-table-v2-row-drag";
import { type PointerEvent, useCallback, useEffect, useRef } from "react";

/**
 * Click-and-drag row range selection for `GridTableV2` (ISS-8747).
 *
 * Reports two things and decides none: the press row, once, when a drag turns
 * out to BE one, and the row under the pointer after that. What a range means
 * stays with `resolveGridRowSelection` on the host side.
 *
 * NOTHING IS REPORTED UNTIL THE POINTER ACTUALLY MOVES TO ANOTHER ROW. A press
 * that never leaves its row emits no activation at all, so a plain click still
 * reaches the host through the row's own `onClick` exactly as it does with this
 * closed — the flag-on and flag-off click paths are the same path.
 *
 * A `Shift`, `Ctrl` or `Cmd` press never begins a drag. Each is already a range
 * or a toggle, owned by the click path, and starting a drag there would report
 * the row twice: once on press and again on the click, which for a `Ctrl` toggle
 * is a flip and a flip back. `Alt` is the one modifier that DOES begin one, and
 * where the host also wires native group drag-and-drop it is the only thing that
 * can — see {@link requireModifier}.
 *
 * A TOUCH press never begins one either: see the `pointerType` guard below.
 */
export function useGridRowRangeDrag({
  enabled,
  isInteractiveTarget,
  onExtendToRow,
  onStartAtRow,
  requireModifier = false,
}: {
  enabled: boolean;
  /**
   * A press on a control that owns its own click never begins a drag.
   *
   * Takes an `Element`, not an `HTMLElement`, because a press lands on whatever
   * the row actually paints and an inline `<svg>` icon is an `SVGElement`
   * (davetho review). Narrowing here turned every press on a decorative glyph
   * — a status icon, a chevron, the provenance mark — into a press that could
   * not start a range at all, while the ancestor walk this predicate already
   * does is exactly what still opts an SVG INSIDE a button back out.
   */
  isInteractiveTarget: (target: Element) => boolean;
  onExtendToRow: (rowId: string) => void;
  onStartAtRow: (rowId: string) => void;
  /**
   * True where the row is ALSO a native HTML drag source, in which case only an
   * `Alt`-modified press begins a range drag (operator ruling, 2026-09-04).
   *
   * The two gestures are otherwise the same one: `dragstart` fires at the
   * browser's own few-pixel threshold and cancels the pointer stream, so an
   * unmodified press-and-drag is a group drag and a range started from it dies
   * at the first move. Requiring the modifier here is the half of the fix the
   * pointer path owns; the other half is the host rendering `draggable={false}`
   * while the modifier is held, without which `dragstart` still wins the race.
   *
   * DEFAULT `false` — where nothing else claims the gesture, an unmodified press
   * keeps starting a range exactly as before, and `Alt` starts one too.
   */
  requireModifier?: boolean;
}) {
  const drag = useRef<ActiveRowDrag | null>(null);
  // Read by listeners that outlive the render which attached them, so a host
  // re-rendering mid-drag (it re-renders on every extend) cannot leave the rest
  // of that drag reporting into a stale closure.
  const latest = useRef({ isInteractiveTarget, onExtendToRow, onStartAtRow });
  useEffect(() => {
    latest.current = { isInteractiveTarget, onExtendToRow, onStartAtRow };
  });

  const endDrag = useCallback(() => {
    const active = drag.current;
    if (!active) {
      return;
    }
    drag.current = null;
    active.gridBody.classList.remove(DRAG_SELECT_SUPPRESSION_CLASS);
    for (const [type, listener] of active.listeners) {
      active.listenerTarget.removeEventListener(type, listener);
    }
    if (active.gridBody.hasPointerCapture(active.pointerId)) {
      active.gridBody.releasePointerCapture(active.pointerId);
    }
    if (active.moved) {
      swallowNextClick(active.gridBody);
    }
  }, []);

  // A drag in flight when the grid unmounts would otherwise leave its listeners
  // and its capture on a detached body.
  useEffect(() => endDrag, [endDrag]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !beginsRangeDrag(event, requireModifier) ||
        !(event.target instanceof Element) ||
        latest.current.isInteractiveTarget(event.target)
      ) {
        return;
      }
      const row = event.currentTarget;
      const rowId = row.dataset.gridRowId;
      const gridBody = row.closest<HTMLElement>(GRID_BODY_SELECTOR);
      if (rowId === undefined || gridBody === null) {
        return;
      }
      // A press arriving while another is live (a second finger, or a button
      // whose release was swallowed) must retire the old drag rather than
      // overwrite it: only the CURRENT drag's listeners are torn down, so
      // overwriting would leak the previous one's `pointermove` onto the body
      // for the life of the grid.
      endDrag();
      // ISS-11865: suppression belongs to the PRESS, and all three halves of it
      // are needed.
      //
      // `preventDefault` is what stops the browser opening a selection at all;
      // without it the first `pointermove` has already started one. It is safe
      // here and only here: every press that is not a range drag has already
      // returned above — a press on an interactive control, a touch press, a
      // modified press — so the default this cancels is the text-selection
      // gesture and nothing else.
      //
      // THE PRESS THEREFORE SUPPRESSES SELECTION ON EVERY PRESS A RANGE DRAG
      // MAY BEGIN FROM, not only on the ones that become drags, so on a host
      // with `requireModifier` off an unmodified mouse press can no longer
      // begin a text selection inside a cell and a double-click no longer
      // selects a word. That is ISS-11865's stated Expected behavior — "never
      // paints a text selection, from the press onward — including travel that
      // never leaves the press row" — and the press cannot know which it is
      // becoming, which is exactly why the old render-time class arrived too
      // late to suppress anything (tamsinb review).
      event.preventDefault();
      // `preventDefault` stops a NEW selection; it does not clear one already
      // painted, and a press landing inside a selection the reader made by hand
      // would otherwise drag with that selection still lit.
      gridBody.ownerDocument.getSelection()?.removeAllRanges();
      // The cancelled default is also what moved focus to the press cell, and
      // the row's `onClick` cannot stand in for it on a drag: `swallowNextClick`
      // eats that click, so focus would stay wherever it was before the press
      // and the next `Shift+ArrowDown` or `Escape` would go THERE rather than to
      // the range the pointer just dragged (tamsinb review).
      focusCellFromRowClick(event.target);
      // Imperative, not React state, because a re-render is at least a frame
      // away and the pointer does not wait for one. The class is added here and
      // removed in `endDrag`, so the grid body carries it for exactly the life
      // of the press rather than for the life of the grid.
      gridBody.classList.add(DRAG_SELECT_SUPPRESSION_CLASS);
      const onPointerMove = (moveEvent: Event) => {
        const active = drag.current;
        if (
          !(active && moveEvent instanceof globalThis.PointerEvent) ||
          moveEvent.pointerId !== active.pointerId
        ) {
          return;
        }
        const overRowId = resolveDragRowIdAtPoint(
          active.gridBody,
          moveEvent.clientY
        );
        if (overRowId === null || overRowId === active.lastRowId) {
          return;
        }
        if (!active.moved) {
          // The press row is reported HERE rather than on the press itself, so
          // that a click that never became a drag reports nothing extra. It is
          // reported unmodified, which is what makes it the anchor the extend
          // below — and every later `Shift`-click or `Shift`+arrow — resolves
          // from.
          active.moved = true;
          // Capture is taken HERE, not on the press, and that is a correctness
          // requirement rather than a saving. While a capture is held every
          // pointer event AND the compatibility mouse events retarget to the
          // capture element, so the `click` closing a press is dispatched at
          // the grid body — an ANCESTOR of the row — and the row's own
          // `onClick` is no longer in its propagation path. Capturing on every
          // press would therefore break plain click-to-select on every row the
          // moment this gate opened.
          active.gridBody.setPointerCapture(active.pointerId);
          latest.current.onStartAtRow(active.pressRowId);
        }
        active.lastRowId = overRowId;
        latest.current.onExtendToRow(overRowId);
      };
      // Pointer-scoped, so a second finger's release cannot commit and tear
      // down a drag the first finger is still driving.
      const onPointerEnd = (endEvent: Event) => {
        const active = drag.current;
        if (
          active &&
          endEvent instanceof globalThis.PointerEvent &&
          endEvent.pointerId !== active.pointerId
        ) {
          return;
        }
        endDrag();
      };
      const listeners: [string, EventListener][] = [
        ["pointermove", onPointerMove],
        ["pointerup", onPointerEnd],
        ["pointercancel", onPointerEnd],
        ["lostpointercapture", onPointerEnd],
      ];
      // The DOCUMENT, not the grid body, and that is a correctness requirement
      // rather than a wider net (davetho review). Capture is deferred to the
      // first move, so between the press and that move NOTHING retargets the
      // pointer stream: a press that leaves the grid before it has crossed a
      // row inside it sends its `pointermove` and `pointerup` to whatever they
      // are actually over, and a body-scoped listener never hears either. The
      // drag then survives with its listeners attached until the next press or
      // unmount, and the range neither clamps to the boundary nor cleans up.
      // Once capture IS taken the events retarget to the body and still bubble
      // here, so the same listeners serve both halves of the drag.
      const listenerTarget: EventTarget = gridBody.ownerDocument;
      drag.current = {
        gridBody,
        lastRowId: rowId,
        listenerTarget,
        listeners,
        moved: false,
        pointerId: event.pointerId,
        pressRowId: rowId,
      };
      // Capture is deferred to the first move (see `onPointerMove`); it is
      // taken on the BODY rather than the pressed row, because capture routes
      // every later pointer event to the capture element and capturing the row
      // would stop the rows the drag passes over from ever seeing the pointer —
      // while still making a release outside the grid commit.
      for (const [type, listener] of listeners) {
        listenerTarget.addEventListener(type, listener);
      }
    },
    [endDrag, requireModifier]
  );

  return {
    rowProps: enabled ? { onPointerDown } : undefined,
  } as const;
}

/**
 * Whether this press is one a range drag may begin from.
 *
 * Separated from the press handler so the handler stays one job — the modifier
 * and pointer-type questions are answered before it, not woven through it.
 */
function beginsRangeDrag(
  event: PointerEvent<HTMLDivElement>,
  requireModifier: boolean
): boolean {
  if (event.button !== PRIMARY_POINTER_BUTTON) {
    return false;
  }
  // A touch press is a SCROLL until proven otherwise (tamsinb review cid
  // 3930344635). A finger dragging the list fires `pointerdown` with
  // `button === 0` and then `pointermove` exactly like a mouse does, so without
  // this every scroll on a tablet or a touchscreen laptop selected the rows it
  // passed instead of moving the list. There is no modifier key on a
  // touchscreen to disambiguate with, so touch keeps the behaviour it has today
  // and this hook stays out of it.
  if (event.pointerType === TOUCH_POINTER_TYPE) {
    return false;
  }
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.altKey || !requireModifier;
}

/**
 * Swallow the `click` a completed drag's own release synthesizes.
 *
 * That click carries no `Shift`, so a host resolving it would collapse the
 * range the user just dragged onto whichever single row it landed on. Caught in
 * the CAPTURE phase on the grid body, which is above every row and below
 * React's root listener, so neither the row's handler nor React's synthetic
 * `onClick` ever sees it.
 *
 * Disarmed on the next task as well as by firing, because a release OUTSIDE the
 * grid produces no click at all — a listener left armed for that case would eat
 * the user's next real click instead, which is a worse bug than the one it was
 * added to fix.
 */
function swallowNextClick(gridBody: HTMLElement): void {
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  gridBody.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => {
    gridBody.removeEventListener("click", swallow, { capture: true });
  }, 0);
}

const PRIMARY_POINTER_BUTTON = 0;
const TOUCH_POINTER_TYPE = "touch";

type ActiveRowDrag = {
  gridBody: HTMLElement;
  /** The last row an extend was reported for, so a move within one row is inert. */
  lastRowId: string;
  listeners: [string, EventListener][];
  /**
   * Where {@link listeners} are attached, kept on the drag rather than re-derived
   * at teardown: `endDrag` must detach from the SAME target the press attached
   * to, and a drag whose grid body unmounted mid-flight can no longer answer for
   * its own document.
   */
  listenerTarget: EventTarget;
  /** Whether the pointer ever reached another row — a press alone is not a drag. */
  moved: boolean;
  pointerId: number;
  pressRowId: string;
};

/**
 * The class the grid body carries for the life of a range-drag press (ISS-11865).
 *
 * Owned here rather than by the component's `className`, because the press
 * cannot wait for a render: `isDragging` is React state and only flips once the
 * pointer reaches ANOTHER row, so a className keyed off it left the whole
 * press-row travel selecting text, and `user-select: none` arriving afterwards
 * does not clear a selection that already exists.
 */
export const DRAG_SELECT_SUPPRESSION_CLASS = "select-none";
