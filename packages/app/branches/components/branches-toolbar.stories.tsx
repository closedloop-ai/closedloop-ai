import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import {
  BranchesToolbar,
  type BranchesToolbarProps,
} from "@repo/app/branches/components/branches-toolbar";
import { APPROVED_BRANCH_TOGGLEABLE_COLUMNS } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  BranchRowStatus,
  DEFAULT_BRANCH_FILTERS,
} from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const rows = BRANCH_SAMPLE_ROWS.map((row, index) => ({
  ...row,
  collaborators:
    index % 2 === 0
      ? [{ key: "github:kris", name: "Kris Wong" }]
      : [{ key: "github:alex", name: "Alex Morgan" }],
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

const savedViews: BranchesToolbarProps["savedViews"] = {
  views: [
    { id: "review", name: "Review queue" },
    { id: "mine", name: "My branches" },
  ],
  activeViewId: "review",
  modified: false,
  onSelectView: () => undefined,
  onCreateView: () => undefined,
  onUpdateView: () => undefined,
  onRenameView: () => undefined,
  onDeleteView: () => undefined,
};

const meta = {
  title: "App Core/Branches/Branches Toolbar",
  component: BranchesToolbar,
  parameters: {
    layout: "padded",
  },
  args: {
    approved: true,
    dateRange: "30d",
    filters: DEFAULT_BRANCH_FILTERS,
    onDateRangeChange: () => undefined,
    onFiltersChange: () => undefined,
    onResetView: () => undefined,
    onToggleColumn: () => undefined,
    rows,
    visibleColumns,
  },
} satisfies Meta<typeof BranchesToolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The complete PRD-601 facet and visibility controls over representative rows. */
export const ApprovedFacets: Story = {
  render: (args) => <ToolbarHarness {...args} />,
};

/** A selected saved view whose live arrangement still matches its snapshot. */
export const ApprovedSavedView: Story = {
  args: { savedViews },
  render: (args) => <ToolbarHarness {...args} />,
};

/** The saved-view trigger distinguishes a dirty live arrangement from saved state. */
export const ApprovedSavedViewModified: Story = {
  args: {
    savedViews: savedViews ? { ...savedViews, modified: true } : undefined,
  },
  render: (args) => <ToolbarHarness {...args} />,
};

/** Several active facets at phone width exercise toolbar wrapping and chip overflow. */
export const ApprovedNarrowActiveFilters: Story = {
  args: {
    filters: {
      ...DEFAULT_BRANCH_FILTERS,
      names: [rows[0]?.branchName ?? ""],
      owners: [rows[0]?.ownerKey ?? ""],
      repos: [rows[0]?.repo ?? ""],
      statuses: [BranchRowStatus.Merged],
      tags: [rows[0]?.tags?.[0]?.id ?? ""],
    },
    savedViews: savedViews ? { ...savedViews, modified: true } : undefined,
  },
  globals: { viewport: { value: "360-720" } },
  render: (args) => <ToolbarHarness {...args} />,
};

function ToolbarHarness(args: BranchesToolbarProps) {
  const [filters, setFilters] = useState(args.filters);

  return (
    <BranchesToolbar {...args} filters={filters} onFiltersChange={setFilters} />
  );
}
