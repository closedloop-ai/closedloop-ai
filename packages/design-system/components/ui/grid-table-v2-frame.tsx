"use client";

import {
  GRID_TREE_NAV_TABLE_ROLE,
  GRID_NAV_TABLE_ROLE,
} from "@closedloop-ai/design-system/lib/grid-table-navigation";
import type { ReactNode, Ref } from "react";

type GridTableV2FrameProps = {
  ariaColumnCount: number;
  ariaRowCount?: number;
  cardList: ReactNode;
  children: ReactNode;
  containerRef: Ref<HTMLDivElement>;
  gridBodyRef: Ref<HTMLDivElement>;
  hasMeasuredContainer: boolean;
  isMultiSelectable: boolean;
  isNarrowList: boolean;
  isTreeGrid: boolean;
  showCards: boolean;
  staticTableSemantics: boolean;
};

/** Own the grid landmark and optional measured card-fallback frame. */
export function GridTableV2Frame({
  ariaColumnCount,
  ariaRowCount,
  cardList,
  children,
  containerRef,
  gridBodyRef,
  hasMeasuredContainer,
  isMultiSelectable,
  isNarrowList,
  isTreeGrid,
  showCards,
  staticTableSemantics,
}: Readonly<GridTableV2FrameProps>) {
  let tableRole: "table" | typeof GRID_TREE_NAV_TABLE_ROLE | typeof GRID_NAV_TABLE_ROLE = GRID_NAV_TABLE_ROLE;
  if (staticTableSemantics) {
    tableRole = "table";
  } else if (isTreeGrid) {
    tableRole = GRID_TREE_NAV_TABLE_ROLE;
  }
  const grid = (
    <div
      aria-colcount={ariaColumnCount}
      aria-multiselectable={isMultiSelectable ? true : undefined}
      aria-rowcount={ariaRowCount}
      className={isNarrowList ? "w-full min-w-0 border-t" : "min-w-fit border-t"}
      data-grid-body=""
      ref={gridBodyRef}
      role={tableRole}
    >
      {children}
    </div>
  );

  if (!hasMeasuredContainer) {
    return grid;
  }
  return (
    <div className="w-full" ref={containerRef}>
      {showCards ? cardList : (
        <div className={isNarrowList ? "w-full min-w-0" : "min-w-fit"}>
          {grid}
        </div>
      )}
    </div>
  );
}
