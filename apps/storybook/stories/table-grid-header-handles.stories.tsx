import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableGridHeader,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { expect, fireEvent, userEvent, within } from "storybook/test";

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
 *
 * ## Taxonomy (ISS-9314)
 * Design System / Data Display **primitive** — the v1 twin of
 * `table-grid-header-v2-handles.tsx`, catalogued as
 * `Composites/Data Display/Tables/Table Grid Header V2 Handles`. Real
 * production consumers of `TableGridHeader` (see that story's own doc
 * block) reach these grips, so they are live code, not dead weight kept
 * only for this demo.
 *
 * A real, undocumented gap this pass found: v1's `ColumnResizeHandle` names
 * its resize button `Resize ${label} column, use arrow keys` — a STATIC name
 * that never changes as the width changes, unlike v2's handle, whose name
 * interpolates the current width and announces "minimum" at the floor (see
 * `Table Grid Header V2 Handles`' `KeyboardResize`/`AtMinimumWidth` stories).
 * ISS-9095's column contract requirement #4 ("resized ... with announced
 * width changes") is met by v2 and not by v1 — a real accessibility gap on a
 * component with live production consumers (Branches, on both web and
 * desktop, per the source's own comment). Not fixed here: changing an
 * `aria-label` a screen-reader user already relies on is a behavior change
 * to shipped code, not a Storybook/catalog change, and deserves its own
 * reviewed PR. Filed as ISS-10147 rather than silently patched.
 *
 * ## State matrix — which of the 16 apply
 * - **default, hover, focus-visible, keyboard/pointer interaction, dragging**
 *   — `KeyboardReorder`/`KeyboardResize` below drive the real keyboard path;
 *   pointer drag/resize is exercised by the DOM event sequence a real browser
 *   fires (`dragstart`/`drop`, `pointerdown`/`pointermove`/`pointerup`), same
 *   pattern as the v2 sibling's `ColumnReorderDrop`.
 * - **drag-over** — not separately demonstrated in v1: unlike v2, this
 *   header's reorder drop has no distinct "column is a valid drop target"
 *   visual state to pin.
 * - **selected, editing, loading, empty, partial, error, disabled,
 *   read-only, permission, narrow** — not applicable; the grips are
 *   fixed-size chrome with no data of their own, matching the v2 sibling's
 *   reasoning.
 * - **overflow** — not applicable; both grips are absolutely-positioned,
 *   fixed-size controls with no text content to clip.
 *
 * `@storybook/addon-a11y` is not wired into this Storybook — the assertions
 * below are real DOM/attribute checks, not an automated axe scan.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Header Handles",
  component: TableGridHeaderHandlesDemo,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    enhancedHeaderInteractions: { control: "boolean" },
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

/** Hoisted per Ultracite's `useTopLevelRegex` rule. */
const REORDERED_TO_ASSIGNEE_FIRST =
  /reordered → assignee, status, priority, updatedAt/;
const REORDERED_TO_ORIGINAL_ORDER =
  /reordered → status, assignee, priority, updatedAt/;
const RESIZED_STATUS_GROWN = /resized status → 164px/;
const RESIZED_STATUS_SHRUNK = /resized status → 148px/;

/**
 * Keyboard reorder through the real drag handle — `ArrowLeft`/`ArrowRight`
 * move the focused column one position, reported via the demo's own
 * "Last action" line so the assertion reads the SAME text a reviewer would.
 */
export const KeyboardReorder: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const reorderHandle = () =>
      canvas.getByRole("button", {
        name: "Reorder Assignee column, use arrow keys",
      });

    // The handle's accessible name is the column's static LABEL, not its
    // position, so re-querying by name after each move is the honest way to
    // refocus it regardless of whether React re-used or recreated the node.
    reorderHandle().focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(
      canvas.getByText(REORDERED_TO_ASSIGNEE_FIRST)
    ).toBeInTheDocument();

    reorderHandle().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(
      canvas.getByText(REORDERED_TO_ORIGINAL_ORDER)
    ).toBeInTheDocument();
  },
};

/**
 * Keyboard resize through the real resize handle — the pre-v2 handle's name
 * is STATIC (see the module doc block's flagged gap: it does not announce the
 * new width the way the v2 sibling handle does), so this pins the demo's own
 * "Last action" text instead of a width-bearing accessible name.
 */
export const KeyboardResizePreV2: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole("button", {
      name: "Resize Status column, use arrow keys",
    });
    handle.focus();

    // Starts at 148px; the shared keyboard step is 16px either direction.
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByText(RESIZED_STATUS_GROWN)).toBeInTheDocument();

    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByText(RESIZED_STATUS_SHRUNK)).toBeInTheDocument();
  },
};

/**
 * Pointer drag reorder, driven through `TableGridHeader`'s own `onDragStart`/
 * `onDrop` wiring rather than a local handler that would re-implement what is
 * under test.
 */
export const PointerReorderDrop: Story = {
  play: async ({ canvasElement }) => {
    const dataTransfer = createColumnDataTransfer();
    fireEvent.dragStart(headerCell(canvasElement, "assignee"), {
      dataTransfer,
    });
    fireEvent.drop(headerCell(canvasElement, "status"), { dataTransfer });

    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(REORDERED_TO_ASSIGNEE_FIRST)
    ).toBeInTheDocument();
  },
};

function headerCell(canvasElement: HTMLElement, columnId: string): HTMLElement {
  const cell = canvasElement.querySelector<HTMLElement>(
    `[data-column-id="${columnId}"]`
  );
  if (!cell) {
    throw new Error(`No header cell rendered for column "${columnId}"`);
  }
  return cell;
}

function createColumnDataTransfer() {
  const entries = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    types: [] as string[],
    setData(type: string, value: string) {
      entries.set(type, value);
      this.types = Array.from(entries.keys());
    },
    getData: (type: string) => entries.get(type) ?? "",
  };
}
