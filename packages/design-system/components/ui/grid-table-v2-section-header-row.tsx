"use client";

import { FIRST_COLUMN_INDEX } from "@closedloop-ai/design-system/lib/grid-table-aria";
import { GRID_NAV_CELL_ROLE } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import {
  buildChromeRowProps,
  type GridChromeCellProps,
  NAVIGABLE_CHROME_CELL_CLASS,
} from "@closedloop-ai/design-system/lib/grid-table-v2-chrome-rows";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import { GroupSectionHeader } from "./group-section-header";

/**
 * A group's (or subgroup's) collapsible header, as a row of the grid.
 *
 * A `grid` may own only rows and rowgroups, so the header cannot be a bare
 * child of its section: it is a `row` whose single cell spans every track. The
 * group and subgroup headers differ only in indentation, which is why they
 * share this rather than each spelling the same ownership tree out.
 */
export function GridTableV2SectionHeaderRow({
  className,
  columnCount,
  count,
  icon,
  isContinued,
  isOpen,
  label,
  navigation,
  onToggle,
  staticTableSemantics = false,
}: {
  className: string;
  columnCount: number;
  count?: number;
  icon?: ReactNode;
  /** This band's rows began on an earlier page (`GridTableV2Group.isContinued`). */
  isContinued?: boolean;
  isOpen: boolean;
  label: string;
  /**
   * Roving-focus wiring for this header's single cell (ISS-8930). Present → the
   * row joins the grid's row walk, so `ArrowUp` from the band's first data row
   * reaches the collapse toggle instead of skipping the band entirely. Absent →
   * byte-identical to before, and the toggle keeps its own native tab stop.
   */
  navigation?: { rowId: string; cellProps: GridChromeCellProps };
  onToggle: () => void;
  staticTableSemantics?: boolean;
}) {
  return (
    <div data-grid-group-header="" role="row" {...(navigation ? buildChromeRowProps(navigation.rowId) : undefined)}>
      <div
        aria-colindex={FIRST_COLUMN_INDEX}
        aria-colspan={columnCount}
        className={cn(navigation && NAVIGABLE_CHROME_CELL_CLASS)}
        role={staticTableSemantics ? "cell" : GRID_NAV_CELL_ROLE}
        {...navigation?.cellProps}
      >
        <GroupSectionHeader
          className={className}
          count={count}
          icon={icon}
          isContinued={isContinued}
          isOpen={isOpen}
          label={label}
          onToggle={onToggle}
        />
      </div>
    </div>
  );
}
