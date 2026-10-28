"use client";

import { isInteractiveRowClickTarget } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import { GRID_TABLE_V2_LONG_PRESS_MS } from "@closedloop-ai/design-system/lib/grid-table-v2-constants";
import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";

/** Row-level touch handlers shared by every narrow `GridTableV2` row. */
export type GridTableV2TouchSelection<T> = {
  onClick: (
    item: T,
    event: MouseEvent<HTMLDivElement>,
    onActivate: (event: MouseEvent<HTMLDivElement>) => void
  ) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerDown: (item: T, event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
};

/**
 * Routes touch gestures through the grid's existing selection callbacks.
 * Long-press always toggles; a tap toggles only after selection mode exists;
 * otherwise the tap follows the row's ordinary activation path.
 */
export function useGridTableV2TouchSelection<T>({
  enabled,
  getCurrentItem,
  getRowId,
  hasSelection,
  onToggle,
}: {
  enabled: boolean;
  getCurrentItem: (rowId: string) => T | undefined;
  getRowId: (item: T) => string;
  hasSelection: boolean;
  onToggle?: (item: T) => void;
}): GridTableV2TouchSelection<T> {
  const latest = useRef({ enabled, getCurrentItem, hasSelection, onToggle });
  latest.current = { enabled, getCurrentItem, hasSelection, onToggle };
  const activePress = useRef<ActivePress | null>(null);
  const pressPointerType = useRef<string | null>(null);
  const suppressNextTouchClick = useRef(false);

  const clearActivePress = useCallback(() => {
    const active = activePress.current;
    if (active) {
      clearTimeout(active.timer);
      activePress.current = null;
    }
  }, []);

  useEffect(() => clearActivePress, [clearActivePress]);
  useEffect(() => {
    if (!enabled || !onToggle) {
      clearActivePress();
      pressPointerType.current = null;
      suppressNextTouchClick.current = false;
    }
  }, [clearActivePress, enabled, onToggle]);

  const endPress = (event: PointerEvent<HTMLDivElement>) => {
    const active = activePress.current;
    if (active && active.pointerId === event.pointerId) {
      clearActivePress();
    }
  };

  return {
    onClick: (item, event, onActivate) => {
      if (
        event.target instanceof globalThis.Element &&
        isInteractiveRowClickTarget(event.target)
      ) {
        pressPointerType.current = null;
        suppressNextTouchClick.current = false;
        return;
      }
      const pointerType = resolveClickPointerType(
        event,
        pressPointerType.current
      );
      pressPointerType.current = null;
      if (suppressNextTouchClick.current) {
        suppressNextTouchClick.current = false;
        return;
      }
      const current = latest.current;
      if (
        current.enabled &&
        current.hasSelection &&
        current.onToggle &&
        pointerType === TOUCH_POINTER_TYPE
      ) {
        current.onToggle(item);
        return;
      }
      onActivate(event);
    },
    onContextMenu: (event) => {
      if (
        latest.current.enabled &&
        pressPointerType.current === TOUCH_POINTER_TYPE
      ) {
        event.preventDefault();
      }
    },
    onPointerCancel: (event) => {
      const active = activePress.current;
      if (active?.pointerId === event.pointerId) {
        suppressNextTouchClick.current = true;
      }
      endPress(event);
    },
    onPointerDown: (item, event) => {
      clearActivePress();
      const current = latest.current;
      if (
        !current.enabled ||
        !current.onToggle ||
        event.pointerType !== TOUCH_POINTER_TYPE ||
        (event.target instanceof globalThis.Element &&
          isInteractiveRowClickTarget(event.target))
      ) {
        pressPointerType.current = null;
        suppressNextTouchClick.current = false;
        return;
      }
      pressPointerType.current = event.pointerType;
      suppressNextTouchClick.current = false;
      const pointerId = event.pointerId;
      activePress.current = {
        pointerId,
        rowId: getRowId(item),
        timer: setTimeout(() => {
          const active = activePress.current;
          if (active?.pointerId !== pointerId) {
            return;
          }
          activePress.current = null;
          const latestPress = latest.current;
          if (!latestPress.enabled || !latestPress.onToggle) {
            return;
          }
          const currentItem = latestPress.getCurrentItem(active.rowId);
          if (currentItem === undefined) {
            return;
          }
          suppressNextTouchClick.current = true;
          latestPress.onToggle(currentItem);
        }, GRID_TABLE_V2_LONG_PRESS_MS),
        x: event.clientX,
        y: event.clientY,
      };
    },
    onPointerMove: (event) => {
      const active = activePress.current;
      if (
        active?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - active.x, event.clientY - active.y) >
          LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        suppressNextTouchClick.current = true;
        clearActivePress();
      }
    },
    onPointerUp: endPress,
  };
}

type ActivePress = {
  pointerId: number;
  rowId: string;
  timer: ReturnType<typeof setTimeout>;
  x: number;
  y: number;
};

function resolveClickPointerType(
  event: MouseEvent<HTMLDivElement>,
  pressedPointerType: string | null
): string | null {
  if (pressedPointerType !== null) {
    return pressedPointerType;
  }
  return "pointerType" in event.nativeEvent &&
    typeof event.nativeEvent.pointerType === "string"
    ? event.nativeEvent.pointerType
    : null;
}

const TOUCH_POINTER_TYPE = "touch";
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
