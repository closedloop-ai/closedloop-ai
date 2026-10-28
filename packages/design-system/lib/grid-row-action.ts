import type { MouseEvent } from "react";
import { focusCellFromRowClick, isInteractiveRowClickTarget } from "./grid-table-navigation";

export function gridRowActionProps<T>(
  item: T,
  renderedItems: readonly T[],
  onRowClick?: (item: T, event: MouseEvent<HTMLDivElement>, items: readonly T[]) => void
) {
  return {
    "data-analytics-action": onRowClick ? "true" : undefined,
    "data-analytics-label": onRowClick ? "Select row" : undefined,
    "data-analytics-label-source": onRowClick ? JSON.stringify(["Select row"]) : undefined,
    onClick(event: MouseEvent<HTMLDivElement>) {
      if (event.target instanceof Element) {
        if (isInteractiveRowClickTarget(event.target)) {
          return;
        }
        focusCellFromRowClick(event.target);
      }
      onRowClick?.(item, event, renderedItems);
    },
  };
}
