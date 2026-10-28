import { BranchesListToolbarV2 } from "@repo/app/branches/components/branches-list-toolbar-v2";
import {
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
  useBranchViewState,
} from "@repo/app/branches/hooks/use-branch-view-state";
import { DEFAULT_BRANCH_FILTERS } from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import {
  type BranchSortDir,
  type BranchSortKey,
  DEFAULT_BRANCH_SORT_DIR,
  DEFAULT_BRANCH_SORT_KEY,
} from "@repo/app/branches/lib/branch-sort-group";
import type { GridTableListSurfaceMode } from "@repo/design-system/components/ui/grid-table-list-surface";
import {
  GRID_TABLE_TOOLBAR_COMPACT_SLOT,
  GRID_TABLE_TOOLBAR_EXPANDED_SLOT,
} from "@repo/design-system/components/ui/grid-table-toolbar";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

// The Branches list's toolbar (`BranchesListToolbarV2`): the time window, the
// Filter popover over the branch facets, and the Options menu (sort, columns,
// reset). In the list it sits in the list surface's toolbar band, and the
// surface hands it the measured mode: the full cluster beside the table, the
// folded one beside the card list.
// The finished list is Surfaces/Artifacts/Branches/Branches List.

const ROWS = BRANCH_SAMPLE_ROWS.map((row) => ({
  ...row,
  ownerKey: `github:${row.owner.toLowerCase().replaceAll(" ", "-")}`,
}));

const FILTER_BUTTON = /Filter/;
const OPTIONS_BUTTON = /Options/;
const VIEW_BUTTON = /View/;
const EXPANDED_SLOT = `[data-slot="${GRID_TABLE_TOOLBAR_EXPANDED_SLOT}"]`;
const COMPACT_SLOT = `[data-slot="${GRID_TABLE_TOOLBAR_COMPACT_SLOT}"]`;

/**
 * The toolbar on the list page's own view state (`useBranchViewState`, the
 * approved projection, unpersisted), so the Columns switches really hide and
 * show columns and "Reset view" really restores the shipped set, exactly
 * as the page wires them (`branches/page.tsx`: `onToggleColumn: toggleColumn`,
 * `onToggleSummaryCard: toggleSummaryCard`,
 * `onResetView: resetView`).
 */
function ToolbarDemo({ mode }: Readonly<{ mode: GridTableListSurfaceMode }>) {
  const view = useBranchViewState(undefined, true);
  const [filters, setFilters] = useState(DEFAULT_BRANCH_FILTERS);
  return (
    <div className="flex flex-col gap-3">
      <BranchesListToolbarV2
        approved
        columnControls={{
          onResetSort: () =>
            view.setSort(DEFAULT_BRANCH_SORT_KEY, DEFAULT_BRANCH_SORT_DIR),
          onSortChange: (key, dir) =>
            view.setSort(key as BranchSortKey, dir as BranchSortDir),
          sortDir: view.sortDir,
          sortKey: view.sortKey,
        }}
        dateRange={view.dateRange}
        filters={filters}
        hiddenSummaryCards={view.hiddenSummaryCards}
        includePriorityColumn
        mode={mode}
        onDateRangeChange={view.setDateRange}
        onFiltersChange={setFilters}
        onResetView={view.resetView}
        onToggleColumn={view.toggleColumn}
        onToggleSummaryCard={view.toggleSummaryCard}
        rows={ROWS}
        visibleColumns={view.visibleColumns}
      />
      {/* What a table under this toolbar would show, so each change is seen. */}
      <p
        className="text-muted-foreground text-xs"
        data-testid="visible-columns"
      >
        Visible columns:{" "}
        {APPROVED_BRANCH_TOGGLEABLE_COLUMNS.filter((column) =>
          view.visibleColumns.has(column.id)
        )
          .map((column) => column.label)
          .join(", ")}
      </p>
    </div>
  );
}

const meta = {
  title: "Composites/Artifacts/Branches/Branches List/Toolbar",
  tags: ["stable"],
  render: () => <ToolbarDemo mode="expanded" />,
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Beside the table: time window, Filter and Options. A Columns switch hides
 * its column, and "Reset view" brings the shipped set back.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const [first] = APPROVED_BRANCH_TOGGLEABLE_COLUMNS;
    if (!first) {
      throw new Error("no toggleable columns");
    }
    const visible = canvas.getByTestId("visible-columns");
    await expect(visible).toHaveTextContent(first.label);

    await userEvent.click(canvas.getByRole("button", { name: OPTIONS_BUTTON }));
    await userEvent.click(
      await page.findByRole("menuitem", { name: first.label })
    );
    await expect(visible).not.toHaveTextContent(first.label);

    await userEvent.click(
      page.getByRole("menuitem", { name: RESET_VIEW_LABEL })
    );
    await expect(visible).toHaveTextContent(first.label);

    await expect(
      canvas.getByRole("button", { name: FILTER_BUTTON })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: OPTIONS_BUTTON })
    ).toBeInTheDocument();
    // The wide cluster only: its slot, and no folded View menu.
    await expect(canvasElement.querySelector(EXPANDED_SLOT)).not.toBeNull();
    await expect(canvasElement.querySelector(COMPACT_SLOT)).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: VIEW_BUTTON })
    ).toBeNull();
  },
};

/** Beside the card list at narrow widths: the folded cluster. */
export const Compact: Story = {
  render: () => <ToolbarDemo mode="compact" />,
  globals: { viewport: { value: "360-720" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector(COMPACT_SLOT)).not.toBeNull();
    await expect(canvasElement.querySelector(EXPANDED_SLOT)).toBeNull();
    await expect(
      canvas.getByRole("button", { name: VIEW_BUTTON })
    ).toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

/** `TableResetViewMenuItem`'s default label. */
const RESET_VIEW_LABEL = "Reset view";
