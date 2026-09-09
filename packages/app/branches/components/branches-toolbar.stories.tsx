import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { readSourceValues } from "@repo/api/src/types/read-source";
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
import { DATE_RANGES } from "@repo/app/shared/lib/format-utils";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

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
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  argTypes: {
    approved: {
      control: "boolean",
      description:
        "Selects the complete PRD-601 facet set over the legacy one.",
      table: { category: "State" },
    },
    dateRange: {
      control: { type: "radio" },
      options: DATE_RANGES,
      table: { category: "State" },
    },
    filters: { control: "object", table: { category: "State" } },
    onDateRangeChange: { control: false, table: { category: "Events" } },
    onFiltersChange: { control: false, table: { category: "Events" } },
    onResetView: { control: false, table: { category: "Events" } },
    onToggleColumn: { control: false, table: { category: "Events" } },
    readSource: {
      control: { type: "radio" },
      options: readSourceValues,
      description: "Store the rows were read from. Unset renders no badge.",
      table: { category: "State" },
    },
    readSourceDetail: {
      control: "text",
      description:
        "Desktop-only sentence explaining why that source is in play.",
      table: { category: "State" },
    },
    readSourceIncomplete: { control: "boolean", table: { category: "State" } },
    rows: { control: "object", table: { category: "Data" } },
    savedViews: {
      control: false,
      description:
        "Named saved views plus their callbacks. Omit to hide the switcher.",
      table: { category: "Data" },
    },
    trailing: { control: false, table: { category: "Content" } },
    visibleColumns: {
      control: false,
      description: "Set of visible column ids. Change it from the View menu.",
      table: { category: "Data" },
    },
  },
  args: {
    approved: true,
    dateRange: "30d",
    filters: DEFAULT_BRANCH_FILTERS,
    onDateRangeChange: fn(),
    onFiltersChange: fn(),
    onResetView: fn(),
    onToggleColumn: fn(),
    readSourceIncomplete: false,
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
