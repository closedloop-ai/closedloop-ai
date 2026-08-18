import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableGridHeader,
  TableGridHeaderAlign,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
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

const meta = {
  title: "Design System/Primitives/Table Grid Header",
  component: TableGridHeaderDemo,
  tags: ["autodocs"],
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
} satisfies Meta<typeof TableGridHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Seeded sort: exactly the active column advertises a direction.
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
