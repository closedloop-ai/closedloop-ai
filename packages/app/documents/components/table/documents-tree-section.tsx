"use client";

import {
  ariaCellProps,
  ariaRowGroupProps,
  ariaRowProps,
  FIRST_COLUMN_INDEX,
} from "@repo/design-system/lib/grid-table-aria";
import type { ReactNode } from "react";

/**
 * One collapsible group section of the Documents tree — its `GroupSectionHeader`
 * plus the rows underneath it (ISS-4761).
 *
 * Extracted from `documents-view.tsx` because the ARIA shape is the interesting
 * part and it belongs beside the header and row renderers it has to agree with,
 * not inside an already-large view. A `role="table"` may own only rows and
 * rowgroups, so a section is a `rowgroup` and its header is a `row` holding one
 * `cell` that spans every track — the same shape a native `<tbody>` plus a
 * full-width `<td colspan>` takes, and the same shape `GridTable` gives its own
 * grouped mode. Without it the section header's disclosure button would be an
 * orphan child of the table.
 *
 * The header keeps its own `aria-expanded` button, so collapsing still reads as
 * a disclosure. With `insideAriaTable` off this renders the prior plain wrapper,
 * byte for byte.
 */
export function DocumentsTreeSection({
  children,
  columnCount,
  insideAriaTable,
  sectionHeader,
}: Readonly<{
  children?: ReactNode;
  /** The table's `aria-colcount`, which the header cell spans in full. */
  columnCount: number;
  insideAriaTable: boolean;
  sectionHeader: ReactNode;
}>) {
  if (!insideAriaTable) {
    return (
      <div>
        {sectionHeader}
        {children}
      </div>
    );
  }

  return (
    <div {...ariaRowGroupProps(true)}>
      <div {...ariaRowProps(true)}>
        <div {...ariaCellProps(true, FIRST_COLUMN_INDEX, columnCount)}>
          {sectionHeader}
        </div>
      </div>
      {children}
    </div>
  );
}
