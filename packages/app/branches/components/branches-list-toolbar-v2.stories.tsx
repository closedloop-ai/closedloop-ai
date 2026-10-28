import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import { BranchesListToolbarV2 } from "@repo/app/branches/components/branches-list-toolbar-v2";
import type {
  BranchesPriorityColumnOptIn,
  BranchesToolbarProps,
} from "@repo/app/branches/components/branches-toolbar-model";
import { APPROVED_BRANCH_TOGGLEABLE_COLUMNS } from "@repo/app/branches/hooks/use-branch-view-state";
import { DEFAULT_BRANCH_FILTERS } from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * ISS-9225 — the Branches Grid Table v2 toolbar, over the same
 * `ListSurfaceToolbarV2` the Sessions v2 toolbar renders.
 *
 * The narrow story is the one that earns its keep: `GridTableToolbar` swaps its
 * wide cluster for a folded one at `md`, and this surface's fold is the Options
 * menu itself rather than the Sessions "View" menu.
 */

const rows = BRANCH_SAMPLE_ROWS.map((row, index) => ({
  ...row,
  ownerKey: `github:${row.owner.toLowerCase().replaceAll(" ", "-")}`,
  tagAvailability: BranchTagAvailability.Available,
  tags:
    index % 2 === 0
      ? [{ id: "tag-ui", name: "UI", color: TagColor.Blue }]
      : [{ id: "tag-data", name: "Data", color: TagColor.Green }],
}));

const visibleColumns = new Set(
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS.map((column) => column.id)
);

const meta = {
  title: "Composites v1.0/Branches/Branches List Toolbar V2",
  component: BranchesListToolbarV2,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    approved: true,
    dateRange: "30d",
    includePriorityColumn: true,
    filters: DEFAULT_BRANCH_FILTERS,
    onDateRangeChange: () => undefined,
    onFiltersChange: () => undefined,
    onResetView: () => undefined,
    onToggleColumn: () => undefined,
    rows,
    visibleColumns,
  },
} satisfies Meta<typeof BranchesListToolbarV2>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The shipped cluster: time window, Filter, Options — nothing else. */
export const Default: Story = {
  render: (args) => <ToolbarHarness {...args} />,
};

/** At phone width the row wraps and the Options menu becomes the folded one. */
export const Narrow: Story = {
  globals: { viewport: { value: "360-720" } },
  render: (args) => <ToolbarHarness {...args} />,
};

function ToolbarHarness(
  args: BranchesToolbarProps & BranchesPriorityColumnOptIn
) {
  const [filters, setFilters] = useState(args.filters);

  return (
    <BranchesListToolbarV2
      {...args}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}
