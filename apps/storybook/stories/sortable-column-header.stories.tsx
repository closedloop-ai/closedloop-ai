import {
  AriaSort,
  getAriaSort,
  SortableColumnHeader,
} from "@repo/design-system/components/ui/sortable-column-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useMemo, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

type SortColumn = "name" | "updatedAt";

const rows = [
  { name: "Agent monitor extraction", updatedAt: "2026-05-29 09:40" },
  { name: "Storybook backfill", updatedAt: "2026-05-29 11:12" },
];

function SortableColumnHeaderDemo({
  initialSortBy = "name",
  initialSortDir = "desc",
}: {
  initialSortBy?: SortColumn | null;
  initialSortDir?: "asc" | "desc";
}) {
  // `initialSortBy`/`initialSortDir` are LOCAL state, not a straight
  // passthrough, because the demo's own click-through sort cycle owns state
  // after mount. A Controls edit still has to reach it, though — a
  // `useState` initializer alone only applies on the FIRST render, so
  // without this sync a Controls change would silently do nothing after
  // mount (found live-testing this exact story against the manager UI).
  const [sortBy, setSortBy] = useState<SortColumn | null>(initialSortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);

  useEffect(() => {
    setSortBy(initialSortBy);
  }, [initialSortBy]);
  useEffect(() => {
    setSortDir(initialSortDir);
  }, [initialSortDir]);

  const sortedRows = useMemo(() => {
    const nextRows = [...rows];

    if (!sortBy) {
      return nextRows;
    }

    nextRows.sort((left, right) => {
      const leftValue = left[sortBy];
      const rightValue = right[sortBy];
      const comparison = leftValue.localeCompare(rightValue);
      return sortDir === "asc" ? comparison : -comparison;
    });

    return nextRows;
  }, [sortBy, sortDir]);

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground text-sm">
        Current sort:{" "}
        <span className="font-medium text-foreground">
          {sortBy ? `${sortBy} (${sortDir})` : "none"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableColumnHeader
              column="name"
              label="Name"
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className="text-right"
              column="updatedAt"
              label="Updated"
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row) => (
            <TableRow key={row.name}>
              <TableCell>{row.name}</TableCell>
              <TableCell className="text-right">{row.updatedAt}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * A sortable `<TableHead>` cell for the classic `<Table>` primitive — ISS-9314.
 *
 * ## Taxonomy
 * Design System / Data Display **primitive**. This is a genuinely SEPARATE
 * component from the Gridview v2 family, not a legacy duplicate: it renders
 * inside a real HTML `<table>` (`TableHead`/`TableRow`), while
 * `TableGridHeaderV2` renders a CSS-grid `role="grid"` row. Real production
 * consumers still use it directly for classic-table surfaces (Insights'
 * `lost-sessions-table.tsx` and `loss-by-person.tsx`) — it is not scheduled
 * for retirement.
 *
 * What this module DOES share with the Gridview column system is its sort
 * PRIMITIVES: `getNextSortDirection`, `SortIndicator`, `getAriaSort`, and the
 * `AriaSort`/`SortDirection` types are imported directly by
 * `table-grid-header.tsx` (v1) and `table-grid-header-v2.tsx` (v2) rather
 * than each re-implementing the three-state sort cycle and its `aria-sort`
 * mapping — that shared-primitive layer, not `SortableColumnHeader` itself,
 * is ISS-9095's "RECONCILE into the canonical header contract" already done.
 *
 * ## State matrix — which of the 16 apply to this primitive
 * - **default, hover, focus-visible, keyboard/pointer interaction** — every
 *   story below; the button is native, so hover/focus styling is the
 *   browser's own `hover:text-foreground` plus default focus ring.
 * - **selected, editing, dragging, drag-over** — not applicable. No selection,
 *   inline edit, or reorder/resize affordance exists at this layer — those
 *   belong to the Gridview v1/v2 header family this component is not part of.
 * - **loading, empty, partial, error** — not applicable; this cell renders
 *   identically regardless of the surrounding table's fetch state, and owns
 *   none of it.
 * - **disabled, read-only, permission** — not applicable. No such prop
 *   exists; a column that should not sort simply is not wired with this
 *   component (its host renders a plain `<TableHead>` instead).
 * - **narrow, overflow** — not applicable to the header cell itself: it has
 *   no fixed width or truncation of its own, and inherits whatever column
 *   width the surrounding `<table>` layout gives it.
 *
 * `@storybook/addon-a11y` is not wired into this Storybook — the assertions
 * below are real `aria-sort`/DOM checks, not an automated axe scan.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Sortable Column Header",
  component: SortableColumnHeaderDemo,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    // The demo's own `SortColumn` union — real enum values, not a free string.
    // `null` is a real member of that union (the `Unsorted` story's whole
    // subject), so the select carries an option that maps back to it; without
    // one, touching this control is a one-way door out of the unsorted state.
    initialSortBy: {
      control: "select",
      options: ["none", "name", "updatedAt"],
      mapping: { none: null },
    },
    initialSortDir: {
      control: { type: "inline-radio" },
      options: ["asc", "desc"],
    },
  },
  parameters: {
    layout: "padded",
  },
  render: (args) => (
    <SortableColumnHeaderDemo
      key={remountKey(args.initialSortBy, args.initialSortDir)}
      {...args}
    />
  ),
} satisfies Meta<typeof SortableColumnHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The active column's `role="columnheader"`, located by its accessible name. */
function columnHeader(
  canvas: ReturnType<typeof within>,
  name: string
): Element {
  return canvas.getByRole("columnheader", { name: new RegExp(name) });
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Seeded descending on "name" — `getAriaSort` is what a screen reader
    // reports, so the assertion is on the attribute, not the caret glyph.
    await expect(columnHeader(canvas, "Name")).toHaveAttribute(
      "aria-sort",
      getAriaSort(true, "desc")
    );
    await expect(columnHeader(canvas, "Updated")).toHaveAttribute(
      "aria-sort",
      AriaSort.None
    );
  },
};

export const Unsorted: Story = {
  args: {
    initialSortBy: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Neither column is active — a SORTABLE header still reports "none"
    // explicitly, which is distinct from carrying no `aria-sort` at all
    // (that would read as "not sortable" instead of "not currently sorted").
    // ISS-10425 ruled that split deliberate across all three components that
    // share `getAriaSort`; its docstring carries the reasoning and the citation.
    // This play is `SortableColumnHeader`'s OWN owner for the inactive-`none`
    // arm — the shared helper's direct unit coverage lives in
    // `packages/design-system/__tests__/aria-sort-inactive-contract.test.tsx`,
    // which deliberately does not restate what this play already pins.
    await expect(columnHeader(canvas, "Name")).toHaveAttribute(
      "aria-sort",
      AriaSort.None
    );
    await expect(columnHeader(canvas, "Updated")).toHaveAttribute(
      "aria-sort",
      AriaSort.None
    );
  },
};

export const Ascending: Story = {
  args: {
    initialSortBy: "updatedAt",
    initialSortDir: "asc",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(columnHeader(canvas, "Updated")).toHaveAttribute(
      "aria-sort",
      AriaSort.Ascending
    );
  },
};

/**
 * The three-state click cycle through the REAL button:
 * inactive → descending (first click on a column always starts descending,
 * per `getNextSortDirection`) → ascending (flip) → descending again (a
 * DIFFERENT column) — while the previously active column releases its
 * direction, because only one column may claim the sort at a time.
 */
export const SortCycle: Story = {
  args: { initialSortBy: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(columnHeader(canvas, "Name")).toHaveAttribute(
      "aria-sort",
      AriaSort.Descending
    );

    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(columnHeader(canvas, "Name")).toHaveAttribute(
      "aria-sort",
      AriaSort.Ascending
    );

    await userEvent.click(canvas.getByRole("button", { name: "Updated" }));
    await expect(columnHeader(canvas, "Updated")).toHaveAttribute(
      "aria-sort",
      AriaSort.Descending
    );
    await expect(columnHeader(canvas, "Name")).toHaveAttribute(
      "aria-sort",
      AriaSort.None
    );
  },
};
