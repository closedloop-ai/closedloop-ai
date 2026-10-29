"use client";

/**
 * Drag-and-drop wiring for one of `GridTableV2`'s group bands (ISS-8296).
 *
 * Extracted from `grid-table-v2.tsx` for the reason its `grid-table-v2-rows`
 * and `grid-table-v2-chrome-rows` siblings were: the component is held against
 * a hard 1,000-line ceiling, and the accept/refuse decision here is a self-
 * contained unit that neither reads nor writes the grid's render state.
 */

import {
  isInteractiveRowClickTarget,
  ownsItsOwnKeys,
  ROW_SELECTION_SURFACE_SELECTOR,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { GRID_CELL_PRIMARY_EDITOR_SELECTOR } from "@closedloop-ai/design-system/lib/grid-cell-keyboard";
import {
  GridInteractionState,
  clearGridDragOverStates,
  clearGridInteractionState,
  hasGridInteractionContract,
  setExclusiveGridDragOverState,
} from "@closedloop-ai/design-system/lib/grid-interaction-contract";
import {
  captureGridRowDragPointerIntent,
  consumeGridRowDragPointerIntent,
} from "@closedloop-ai/design-system/lib/grid-row-drag-pointer-intent";
import type { GridTableV2Group } from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import type { DragEvent } from "react";

export type GridGroupDropHandlers = {
  onDragEnter?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLElement>) => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
};

const GRID_ROW_DRAG_HANDLE_SELECTOR = "[data-grid-row-drag-handle]";

/**
 * Handlers for one band, given the grid's drop callback and its row lookup.
 *
 * Both arms `stopPropagation`, and that is load-bearing in both directions,
 * because a subgroup `rowgroup` is nested INSIDE its parent's:
 *
 * - Without it on the ACCEPTING arm, a drop into a live subgroup bubbles to a
 *   refusing parent, which overwrites `dropEffect` to `"none"` and cancels the
 *   drag — so a legal drop silently never happens.
 * - Without it on the REFUSING arm, the refusal is only an omission, and the
 *   parent's handlers claim the event instead — moving the row on the PRIMARY
 *   field after the drag told the reader the drop was illegal.
 *
 * A refusal must therefore be an ACTIVE pair rather than the absence of one,
 * and it deliberately does not `preventDefault` the dragover: that call is
 * exactly what marks an element a drop target.
 */
export function createGroupDropHandlers<T>({
  canDropOnGroup,
  findItemByDragEvent,
  onGroupDrop,
}: {
  canDropOnGroup?: (
    item: T,
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => boolean;
  findItemByDragEvent: (event: DragEvent<HTMLElement>) => T | undefined;
  onGroupDrop?: (
    item: T,
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>,
    placement?: "start" | "end"
  ) => void;
}) {
  return (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ): GridGroupDropHandlers => {
    if (!onGroupDrop) {
      return {};
    }
    // The most specific band under the pointer owns the decision, matching how
    // the host resolves which field a drop is actually against.
    const destination = subgroup ?? group;
    if (destination.droppable === false) {
      return {
        onDragEnter: (event: DragEvent<HTMLElement>) => {
          if (!hasGridInteractionContract(event.currentTarget)) {
            return;
          }
          clearGridDragOverStates(event.currentTarget);
          event.stopPropagation();
        },
        onDragLeave: clearDragOverOnExitWhenMastered,
        onDragOver: (event: DragEvent<HTMLElement>) => {
          clearDragOverWhenMastered(event.currentTarget);
          event.stopPropagation();
          event.dataTransfer.dropEffect = "none";
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          clearDragOverWhenMastered(event.currentTarget);
          event.preventDefault();
          event.stopPropagation();
        },
      };
    }
    const canAcceptDrop = (event: DragEvent<HTMLElement>) => {
      if (!(canDropOnGroup || hasGridInteractionContract(event.currentTarget))) {
        return true;
      }
      const item = findItemByDragEvent(event);
      return (
        item !== undefined &&
        (canDropOnGroup?.(item, group, subgroup) ?? true)
      );
    };
    return {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!hasGridInteractionContract(event.currentTarget)) {
          return;
        }
        event.stopPropagation();
        if (canAcceptDrop(event)) {
          setExclusiveGridDragOverState(event.currentTarget);
          return;
        }
        clearGridDragOverStates(event.currentTarget);
      },
      onDragLeave: clearDragOverOnExitWhenMastered,
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!canAcceptDrop(event)) {
          clearDragOverWhenMastered(event.currentTarget);
          event.stopPropagation();
          event.dataTransfer.dropEffect = "none";
          return;
        }
        if (hasGridInteractionContract(event.currentTarget)) {
          setExclusiveGridDragOverState(event.currentTarget);
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        clearDragOverWhenMastered(event.currentTarget);
        event.preventDefault();
        event.stopPropagation();
        const item = findItemByDragEvent(event);
        if (item && (canDropOnGroup?.(item, group, subgroup) ?? true)) {
          onGroupDrop(item, group, subgroup, event.target instanceof Element && event.target.closest("[data-grid-group-header]") ? "start":"end");
        }
      },
    };
  };
}

/** The `DataTransfer` type a row drag carries its row id under. */
export const GRID_ROW_DRAG_TYPE = "text/grid-row-id";

/**
 * A draggable row's `dragstart`; true when it became a row drag. A drag that
 * starts INSIDE a text field is the user dragging text they selected there
 * (ISS-9490), and it is cancelled rather than claimed: as a row drag it would
 * move the row to whichever band it lands on, and left native, every band
 * would accept it as a "move" and the browser would delete the dragged text
 * out of the field.
 */
export function startGridRowDrag(
  event: DragEvent<HTMLElement>,
  rowId: string
): boolean {
  const pointerIntent = consumeGridRowDragPointerIntent(event.currentTarget);
  const modified =
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  const canStart = hasGridInteractionContract(event.currentTarget)
    ? !modified &&
      pointerIntent?.canceled !== true &&
      canStartGridRowDragFromTarget(pointerIntent?.target ?? event.target)
    : !ownsItsOwnKeys(event.target);
  if (!canStart) {
    event.preventDefault();
    return false;
  }
  event.dataTransfer.setData(GRID_ROW_DRAG_TYPE, rowId);
  event.dataTransfer.effectAllowed = "move";
  if (hasGridInteractionContract(event.currentTarget)) {
    captureGridRowDragPointerIntent(
      event.currentTarget,
      pointerIntent?.pointerId
    );
  }
  return true;
}

/** Resolves whether a pointer origin is eligible for native row dragging. */
export function canStartGridRowDragFromTarget(
  target: EventTarget | null
): boolean {
  if (!(target instanceof globalThis.Element)) {
    return !ownsItsOwnKeys(target);
  }
  const dragHandle = target.closest(GRID_ROW_DRAG_HANDLE_SELECTOR);
  if (dragHandle) {
    return !dragHandle.matches(":disabled, [aria-disabled='true']");
  }
  if (target.closest("a[href]")) {
    return true;
  }
  return !(
    ownsItsOwnKeys(target) ||
    target.closest(GRID_CELL_PRIMARY_EDITOR_SELECTOR) ||
    target.closest(ROW_SELECTION_SURFACE_SELECTOR) ||
    target.closest("[contenteditable='true']") ||
    isInteractiveRowClickTarget(target)
  );
}

function clearDragOverOnExitWhenMastered(
  event: DragEvent<HTMLElement>
): void {
  if (!hasGridInteractionContract(event.currentTarget)) {
    return;
  }
  if (
    event.relatedTarget instanceof globalThis.Node &&
    event.currentTarget.contains(event.relatedTarget)
  ) {
    return;
  }
  clearGridInteractionState(
    event.currentTarget,
    GridInteractionState.DragOver
  );
}

function clearDragOverWhenMastered(element: HTMLElement): void {
  if (hasGridInteractionContract(element)) {
    clearGridDragOverStates(element);
  }
}
