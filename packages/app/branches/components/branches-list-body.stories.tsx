import { BranchesListBody } from "@repo/app/branches/components/branches-list-body";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import {
  BranchSortDir,
  BranchSortKey,
} from "@repo/app/branches/lib/branch-sort-group";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

const meta = {
  title: "Composites/Branches/Branches List Body",
  component: BranchesListBody,
  tags: ["autodocs"],
  argTypes: {
    items: {
      control: "object",
      description: "The rows this render paints, already windowed and paged.",
      table: { category: "Data" },
    },
    allRows: {
      control: "object",
      description: "Complete pre-pagination cohort behind the current page.",
      table: { category: "Data" },
    },
    approved: { control: "boolean", table: { category: "State" } },
    isPending: { control: "boolean", table: { category: "State" } },
    isError: { control: "boolean", table: { category: "State" } },
    hasRows: { control: "boolean", table: { category: "State" } },
    hasWindow: { control: "boolean", table: { category: "State" } },
    windowedEmptyIsNoMatches: {
      control: "boolean",
      description:
        "The bounded window, not the facet filters, emptied the list.",
      table: { category: "State" },
    },
    tagsReadOnly: { control: "boolean", table: { category: "State" } },
    visibleColumns: {
      control: false,
      description: "Set of data-column ids to render.",
      table: { category: "Appearance" },
    },
    columnOrder: { control: "object", table: { category: "Appearance" } },
    columnWidths: { control: "object", table: { category: "Appearance" } },
    sortBy: {
      control: "select",
      options: Object.values(BranchSortKey),
      table: { category: "Appearance" },
    },
    sortDir: {
      control: "radio",
      options: Object.values(BranchSortDir),
      table: { category: "Appearance" },
    },
    getBranchHref: { control: false, table: { category: "Navigation" } },
    getSessionsHref: { control: false, table: { category: "Navigation" } },
    onSort: { control: false, table: { category: "Events" } },
    onColumnOrderChange: { control: false, table: { category: "Events" } },
    onColumnWidthChange: { control: false, table: { category: "Events" } },
    onShowAllTime: { control: false, table: { category: "Events" } },
    onRetry: { control: false, table: { category: "Events" } },
  },
  parameters: { layout: "fullscreen" },
  args: {
    approved: true,
    allRows: BRANCH_SAMPLE_ROWS,
    isPending: false,
    isError: false,
    hasRows: true,
    hasWindow: true,
    windowedEmptyIsNoMatches: false,
    items: BRANCH_SAMPLE_ROWS.slice(0, 4),
    visibleColumns: new Set([
      "owner",
      "collaborators",
      "sessions",
      "changes",
      "status",
      "pr",
      "lastActivity",
      "repo",
      "tags",
    ]),
    sortBy: BranchSortKey.LastActivity,
    sortDir: BranchSortDir.Desc,
    onSort: fn(),
    columnOrder: [],
    onColumnOrderChange: fn(),
    columnWidths: {},
    onColumnWidthChange: fn(),
    onShowAllTime: fn(),
    onRetry: fn(),
    tagsReadOnly: true,
  },
  render: (args) => (
    <main className="min-h-[400px] overflow-auto p-4">
      <BranchesListBody {...args} />
    </main>
  ),
} satisfies Meta<typeof BranchesListBody>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Loading: Story = {
  args: { hasRows: false, isPending: true, items: [] },
};

export const Unavailable: Story = {
  args: { hasRows: false, isError: true, items: [] },
};

export const NoBranches: Story = {
  args: { hasRows: false, hasWindow: false, items: [] },
};

export const WindowedNoMatches: Story = {
  args: {
    hasRows: false,
    hasWindow: true,
    items: [],
    windowedEmptyIsNoMatches: true,
  },
};

export const FilteredNoMatches: Story = {
  args: { hasRows: true, items: [] },
};
