"use client";

import {
  type GridCellTabStopController,
  suppressGridCellTabStops,
} from "@closedloop-ai/design-system/lib/grid-cell-tab-stops";
import { useCallback, useRef } from "react";

/**
 * Ref for a grid body whose cell contents should stay out of the tab order
 * (ISS-8726). A callback ref rather than an effect because the grid body is
 * conditionally rendered — a responsive table swaps it for a card list — and a
 * ref is told about that directly instead of needing the render branch restated
 * as a dependency.
 *
 * `enabled` false attaches nothing at all, so a closed flag leaves the DOM
 * exactly as it was.
 */
export function useGridCellTabStops(enabled: boolean) {
  const controller = useRef<GridCellTabStopController | null>(null);
  return useCallback(
    (gridBody: HTMLDivElement | null) => {
      controller.current?.dispose();
      controller.current =
        gridBody && enabled ? suppressGridCellTabStops(gridBody) : null;
    },
    [enabled]
  );
}
