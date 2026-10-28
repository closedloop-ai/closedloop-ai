import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableGridHeader,
  TableGridHeaderAlign,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
import { remountKey } from "@repo/design-system/storybook/remount-key";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";

// The lead dropdown trigger is always named by `leadingLabel`, which this demo
// leaves at its "Name" default. It does NOT track the active sort option —
// which is exactly why the cycle play below can re-query one constant name
// across all three states.
const LEADING_SORT_TRIGGER = "Name";

const columns: TableGridHeaderColumn[] = [
  { id: "status", label: "Status", sortable: true },
  { id: "assignee", label: "Assignee", sortable: true },
  { id: "priority", label: "Priority", sortable: true },
  { id: "updatedAt", label: "Updated", sortable: true },
];

const columnsWithTooltips: TableGridHeaderColumn[] = [
  {
    id: "status",
    label: "Status",
    sortable: true,
    tooltip: "Current lifecycle state of the row.",
  },
  { id: "assignee", label: "Assignee", sortable: true },
  {
    id: "priority",
    label: "Priority",
    tooltip: "Relative urgency; higher priority is worked first.",
  },
  { id: "updatedAt", label: "Updated", sortable: true },
];

// ISS-5333: the `headerAlign` canvas — see the `EndAlignedColumns` story.
const endAlignedColumns: TableGridHeaderColumn[] = [
  { id: "assignee", label: "Assignee", sortable: true },
  {
    id: "count",
    label: "Count",
    sortable: true,
    headerAlign: TableGridHeaderAlign.End,
  },
  {
    id: "amount",
    label: "Amount",
    sortable: true,
    tooltip: "Total spend for this row, in USD.",
    headerAlign: TableGridHeaderAlign.End,
  },
  { id: "ratio", label: "Ratio", headerAlign: TableGridHeaderAlign.End },
];

function TableGridHeaderDemo({
  initialSortBy,
  initialSortDir,
  visibleColumns,
  showSelectAll,
  allSelected,
  someSelected,
  withNameSortOptions,
}: {
  initialSortBy: string | null;
  initialSortDir: SortDirection;
  visibleColumns: TableGridHeaderColumn[];
  showSelectAll?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  withNameSortOptions?: boolean;
}) {
  const [sortBy, setSortBy] = useState<string | null>(initialSortBy);
  const [sortDir, setSortDir] = useState<SortDirection>(initialSortDir);

  // The `role="table"` wrapper pairs with `insideAriaTable`: the header emits
  // role="row" / role="columnheader" / aria-sort only when told it sits inside
  // an ARIA table, and those roles would be orphaned without a table ancestor.
  // This is the pairing GridTable always uses in production, so the demo now
  // matches it instead of rendering a header with no semantics.
  return (
    <div className="overflow-x-auto rounded-md border">
      {/* biome-ignore lint/a11y/useSemanticElements: a CSS-grid header row cannot be a real <table>; role="table" is the correct ARIA mapping and is what GridTable itself uses. */}
      <div role="table">
        <TableGridHeader
          allSelected={allSelected}
          columns={visibleColumns}
          gridTemplateColumns={`minmax(280px,1fr) repeat(${visibleColumns.length},124px)`}
          insideAriaTable
          leadingSortKey={withNameSortOptions ? undefined : "title"}
          leadingSortOptions={
            withNameSortOptions
              ? [
                  { key: "title", label: "Name" },
                  { key: "slug", label: "Slug" },
                  { key: "updatedAt", label: "Last updated" },
                ]
              : undefined
          }
          onClearSort={() => setSortBy(null)}
          onSelectAll={() => undefined}
          onSort={(column, direction) => {
            setSortBy(column);
            setSortDir(direction);
          }}
          showSelectAll={showSelectAll}
          someSelected={someSelected}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      </div>
    </div>
  );
}

/**
 * `TableGridHeader` (v1) — the CSS-grid column header GridTable v1 renders.
 * ISS-9314's catalog audit.
 *
 * ## Taxonomy
 * Design System / Data Display **primitive**. This is the v1 twin of
 * `TableGridHeaderV2` (`Composites/Data Display/Tables/Table Grid Header V2`),
 * not a deprecated predecessor to fold away: it has real production
 * consumers today — `packages/app/documents/components/table/table-header.tsx`
 * (the Documents table), `packages/app/agents/components/workspace/agents-table.tsx`,
 * `packages/app/branches/components/branches-table.tsx` and
 * `approved-branches-table.tsx`, and
 * `packages/app/packs/components/{admin,member}-view.tsx` — verified by
 * grepping `from ".../table-grid-header"` across the repo (the first two
 * import it directly; the rest render it transitively through `GridTable`,
 * which itself imports `TableGridHeader`), not asserted from this ticket's
 * text. ISS-9095's reconciliation disposition lists "Table Grid
 * Header" as RECONCILE, but its own cited evidence (story id
 * `design-system-primitives-table-grid-header--default`, sourced from
 * `table-grid-header-v2.tsx`) does not match reality on two counts. It named
 * THIS file (v1), not `table-grid-header-v2.tsx`, which has its own
 * separately titled story; and that id no longer resolves at all, because
 * this pass retitles this file out of "Primitives" into "Data Display" (see
 * `meta.title` below) — the live id is now
 * `design-system-data-display-table-grid-header--default`. Cite that one;
 * the `…-primitives-…` id is gone. Flagged here rather than corrected in the ticket —
 * whether v1's real consumers above are meant to migrate onto v2, stay on v1
 * indefinitely, or something else is a product/ownership call this Storybook
 * pass should not make unilaterally.
 *
 * What v1 and v2 already share: the sort primitives (`getNextSortDirection`,
 * `SortIndicator`, `getAriaSort`, `AriaSort`/`SortDirection`) from
 * `sortable-column-header.tsx`, and (structurally) the same column-menu
 * concept via two independently-maintained implementations — see
 * `Composites/Data Display/Tables/Table Grid Header V2 Label`'s doc block for the
 * concrete divergences found between them.
 *
 * ## State matrix — which of the 16 apply
 * - **default, hover, focus-visible, keyboard/pointer interaction** — every
 *   story below drives real sort clicks; `EndAlignedColumns` and
 *   `WithColumnTooltips` cover the two column-level display options.
 * - **selected** — `showSelectAll`/`allSelected`/`someSelected` cover the
 *   tri-state select-all this header renders (see `Default`'s args).
 * - **dragging, drag-over** — owned by the sibling `table-grid-header-handles`
 *   module (its own story, `ColumnDragHandle`/`ColumnResizeHandle`), not
 *   demonstrated redundantly here.
 * - **editing, loading, empty, partial, error** — not applicable; this header
 *   renders identically regardless of the body's data/fetch/edit state, which
 *   it does not own.
 * - **disabled, read-only, permission** — not applicable. No such prop exists
 *   on `TableGridHeader` or its column type; a column that should offer no
 *   sort/menu capability is simply declared without `sortable`/`filterable`/
 *   `groupable`/`movable`, the same by-omission pattern as v2.
 * - **narrow, overflow** — not demonstrated in THIS file. `MinimalColumns`
 *   narrows the column set but does not force a column below its content
 *   width; overflow/truncation for this family is exercised at the CELL layer
 *   (`Primitives/Data Display/Tables/Grid Table V2 Cell`'s `Overflow` story) and
 *   at the v2 header layer (`Table Grid Header V2`'s `Overflow` story) —
 *   flagged as a real, minor coverage gap for v1 specifically rather than
 *   claimed as covered.
 *
 * `@storybook/addon-a11y` is not wired into this Storybook — the assertions
 * below are real `aria-sort`/role/attribute checks, not an automated axe scan.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Grid Header",
  component: TableGridHeaderDemo,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    initialSortBy: "updatedAt",
    initialSortDir: "desc",
    visibleColumns: columns,
    showSelectAll: true,
    allSelected: false,
    someSelected: true,
    withNameSortOptions: true,
  },
  argTypes: {
    initialSortDir: {
      control: { type: "inline-radio" },
      options: ["asc", "desc"],
    },
  },
  render: (args) => (
    <TableGridHeaderDemo
      key={remountKey(args.initialSortBy, args.initialSortDir)}
      {...args}
    />
  ),
} satisfies Meta<typeof TableGridHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Seeded sort: exactly the active column advertises a direction, while a
    // sortable-but-unsorted one still publishes "none" rather than nothing —
    // the ISS-10425 ruling, argued in `getAriaSort`'s docstring.
    await expect(dataColumnHeader(canvas, "updatedAt")).toHaveAttribute(
      "aria-sort",
      "descending"
    );
    await expect(dataColumnHeader(canvas, "status")).toHaveAttribute(
      "aria-sort",
      "none"
    );

    // A column the table is NOT already sorted by starts DESCENDING — the
    // opposite of DataTable's ascending-first column header. The two
    // primitives genuinely differ, so this pins which one this is.
    await userEvent.click(canvas.getByRole("button", { name: "Status" }));
    await expect(dataColumnHeader(canvas, "status")).toHaveAttribute(
      "aria-sort",
      "descending"
    );

    // Sort is single-column: the previously active header drops its direction
    // rather than both claiming one.
    await expect(dataColumnHeader(canvas, "updatedAt")).toHaveAttribute(
      "aria-sort",
      "none"
    );

    // The active column then flips instead of re-applying descending.
    await userEvent.click(canvas.getByRole("button", { name: "Status" }));
    await expect(dataColumnHeader(canvas, "status")).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
  },
};

export const SimpleNameSort: Story = {
  args: {
    withNameSortOptions: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leadHeader = () => canvas.getAllByRole("columnheader")[0];

    // With a single `leadingSortKey` the lead column is a plain button and
    // follows the same descending-first, then-flip cycle as a data column.
    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(leadHeader()).toHaveAttribute("aria-sort", "descending");
    await expect(dataColumnHeader(canvas, "updatedAt")).toHaveAttribute(
      "aria-sort",
      "none"
    );

    await userEvent.click(canvas.getByRole("button", { name: "Name" }));
    await expect(leadHeader()).toHaveAttribute("aria-sort", "ascending");
  },
};

/**
 * `leadingSortOptions` swaps the lead button for a dropdown with a THREE-state
 * cycle per option: inactive to ascending, ascending to descending, then
 * descending CLEARS the sort via `onClearSort` rather than cycling back.
 *
 * The lead cell reports `aria-sort` in this variant too: `getLeadingAriaSort`
 * tests `sortOptions` before `sortKey`, and the header's own stated contract is
 * that both branches resolve to the same announced state.
 */
export const LeadingSortCycle: Story = {
  args: {
    initialSortBy: null,
    initialSortDir: "asc",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leadHeader = () => canvas.getAllByRole("columnheader")[0];

    for (const expectedSort of ["ascending", "descending", "none"]) {
      await userEvent.click(
        canvas.getByRole("button", { name: LEADING_SORT_TRIGGER })
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Name" })
      );
      await expect(leadHeader()).toHaveAttribute("aria-sort", expectedSort);
    }
  },
};

export const MinimalColumns: Story = {
  args: {
    visibleColumns: columns.slice(0, 2),
    showSelectAll: false,
    someSelected: false,
  },
};

// Columns can opt into a `tooltip`, which renders a `HeaderTooltip` info-icon
// button (with an accessible `<label> help` aria-label) after the label. Hover
// or focus the icon to reveal the help text.
export const WithColumnTooltips: Story = {
  args: {
    visibleColumns: columnsWithTooltips,
  },
};

/**
 * ISS-5333 — `headerAlign: End`, the opt-in a numeric column uses so its label
 * sits over its digits.
 *
 * It exists as a real prop rather than a `justify-end` in `className` because on
 * a SORTABLE column that class is inert: the cell is a flex row, but a sortable
 * header wraps its label in a `flex-1` button that consumes the cell, leaving
 * the cell's `justify-*` nothing to distribute. `headerAlign` applies to both.
 *
 * The mix here is the point. `Count` sorts and has no tooltip, `Amount` sorts
 * and has one, `Ratio` does NOT sort (a bare span in the cell, the arm that used
 * to be the only one that worked), and `Assignee` is left alone — so a header
 * row with both alignments is visible at once. On the aligned columns the caret
 * and the help icon LEAD the label, so the label itself lands on the right rail
 * instead of being pushed inboard by its own adornments.
 */
export const EndAlignedColumns: Story = {
  args: {
    visibleColumns: endAlignedColumns,
  },
};

// The header cell for a data column, located by the `data-column-id` the
// component stamps on each one. Asserting `aria-sort` here reads the durable
// accessibility contract rather than the caret icon, which carries no
// accessible name.
function dataColumnHeader(
  canvas: ReturnType<typeof within>,
  columnId: string
): Element {
  const cell = canvas
    .getByRole("row")
    .querySelector(`[data-column-id="${columnId}"]`);
  if (cell === null) {
    throw new Error(`no header cell rendered for column "${columnId}"`);
  }
  return cell;
}
