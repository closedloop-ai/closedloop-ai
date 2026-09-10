import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableGridHeader,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";

/**
 * ISS-5333 — the catalog home for `table-grid-header-handles.tsx`, the module
 * this ticket split out of `table-grid-header.tsx` (that file was at 996 lines
 * against the repo's 1,000-line ceiling).
 *
 * The two grips it owns — `ColumnDragHandle` (position) and `ColumnResizeHandle`
 * (width) — are deliberately mounted THROUGH `TableGridHeader` rather than
 * standalone, because standalone is not a state they can be in: both are
 * absolutely positioned against a header cell's `relative` box, and the header
 * is what decides whether either renders at all (`canReorder` / `canResize`).
 * A story that rendered them bare would draw two floating glyphs and prove
 * nothing about what ships.
 *
 * Both PRESENTATION variants are mounted, because they are different markup and
 * this is where that split is supposed to stay visible:
 *
 *  - pre-v2 (`enhancedHeaderInteractions` absent) — the resize handle is a 1.5px
 *    strip with a visible on-token divider bar inside it, revealed on header
 *    hover or keyboard focus.
 *  - v2 (`enhancedHeaderInteractions` on) — hit area and visual are decoupled: a
 *    12px strip straddling the divider, with an `after:` hairline that fades in
 *    at 40% on column hover, 70% inside the strip, and full on focus/drag.
 */

const COLUMNS: TableGridHeaderColumn[] = [
  { id: "status", label: "Status", sortable: true },
  { id: "assignee", label: "Assignee", sortable: true },
  { id: "priority", label: "Priority", sortable: true },
  { id: "updatedAt", label: "Updated", sortable: true },
];

const LEAD_TRACK = "minmax(240px,1fr)";
const INITIAL_COLUMN_WIDTH_PX = 148;

function TableGridHeaderHandlesDemo({
  enhancedHeaderInteractions,
}: {
  enhancedHeaderInteractions?: boolean;
}) {
  const [sortBy, setSortBy] = useState<string | null>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [columnOrder, setColumnOrder] = useState<string[]>(
    COLUMNS.map((column) => column.id)
  );
  // FEA-4168: only columns the caller seeds into this map are resizable, so a
  // story that omitted it would render NO resize handle at all — which is
  // exactly the gap this story exists to close.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      COLUMNS.map((column) => [column.id, INITIAL_COLUMN_WIDTH_PX])
    )
  );
  const [lastAction, setLastAction] = useState("—");

  const orderedColumns = useMemo(
    () =>
      columnOrder
        .map((id) => COLUMNS.find((column) => column.id === id))
        .filter((column): column is TableGridHeaderColumn => column != null),
    [columnOrder]
  );
  const gridTemplateColumns = [
    LEAD_TRACK,
    ...orderedColumns.map(
      (column) => `${columnWidths[column.id] ?? INITIAL_COLUMN_WIDTH_PX}px`
    ),
  ].join(" ");

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Hover a column header for its grips. Drag the grip on the left of a
        label to reorder (or focus it and press ArrowLeft/ArrowRight); drag a
        column's right edge to resize (or focus that handle and use the arrow
        keys). Last action: <span className="font-medium">{lastAction}</span>
      </p>
      <div className="overflow-x-auto rounded-md border">
        <TableGridHeader
          columns={orderedColumns}
          enhancedHeaderInteractions={enhancedHeaderInteractions}
          gridTemplateColumns={gridTemplateColumns}
          leadingSortKey="title"
          onSort={(column, direction) => {
            setSortBy(column);
            setSortDir(direction);
          }}
          reorder={{
            columnOrder,
            onReorder: (nextOrder) => {
              setColumnOrder(nextOrder);
              setLastAction(`reordered → ${nextOrder.join(", ")}`);
            },
          }}
          resize={{
            columnIds: COLUMNS.map((column) => column.id),
            getColumnWidth: (columnId) =>
              columnWidths[columnId] ?? INITIAL_COLUMN_WIDTH_PX,
            onResize: (columnId, widthPx) => {
              setColumnWidths((previous) => ({
                ...previous,
                [columnId]: widthPx,
              }));
              setLastAction(`resized ${columnId} → ${widthPx}px`);
            },
          }}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Primitives/Layout/Table Grid Header Handles",
  component: TableGridHeaderHandlesDemo,
  tags: ["autodocs"],
  argTypes: {
    enhancedHeaderInteractions: {
      control: "boolean",
      description:
        "Switches the resize affordance from the pre-v2 1.5px divider bar to the GridTable v2 12px hit-strip with its `after:` hairline.",
    },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    enhancedHeaderInteractions: false,
  },
} satisfies Meta<typeof TableGridHeaderHandlesDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Pre-v2 presentation: the resize handle is a narrow strip carrying a visible
 * on-token divider bar, revealed on header hover or keyboard focus. This is what
 * every table that has not opted into `enhancedHeaderInteractions` renders.
 */
export const Default: Story = {};

/**
 * GridTable v2 presentation. The resize affordance is the decoupled 12px
 * hit-strip plus `after:` hairline, and the drag handle's column shows the v2
 * fade/insertion feedback. Mounted beside `Default` so the two resize-handle
 * variants are comparable on one page rather than one being invisible.
 */
export const EnhancedInteractions: Story = {
  args: {
    enhancedHeaderInteractions: true,
  },
};
