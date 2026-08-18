import { BranchesListBody } from "@repo/app/branches/components/branches-list-body";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "App Core/Branches/Branches List Body",
  component: BranchesListBody,
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
    sortBy: "lastActivity",
    sortDir: "desc",
    onSort: () => undefined,
    columnOrder: [],
    onColumnOrderChange: () => undefined,
    columnWidths: {},
    onColumnWidthChange: () => undefined,
    onShowAllTime: () => undefined,
    onRetry: () => undefined,
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
