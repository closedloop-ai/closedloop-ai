import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { BranchesTable } from "@repo/app/branches/components/branches-table";
import { BranchesToolbar } from "@repo/app/branches/components/branches-toolbar";
import { useBranchFilterState } from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import {
  type BranchRow,
  BranchRowStatus,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import {
  type BranchSortDir,
  type BranchSortKey,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo } from "react";

/**
 * Presentational branches table shared by the web `/branches` page and the
 * desktop Branches view. Callers supply display-ready `BranchRow` items;
 * `BranchesToolbar` drives Filter (status/owner/repository) + View (group by /
 * columns), and column headers drive sorting.
 */
const meta = {
  title: "App Core/Branches/Branches Table",
  component: BranchesTable,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BranchesTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { items: BRANCH_SAMPLE_ROWS },
  render: (args) => (
    <main className="h-[400px] overflow-auto">
      <BranchesTable {...args} />
    </main>
  ),
};

const APPROVED_ROW: BranchRow = {
  ...BRANCH_SAMPLE_ROWS[0]!,
  id: "approved-default",
  branchName: "codex/branches-list-ui",
  repo: "closedloop-ai/symphony-alpha",
  owner: "Daniel Ochoa",
  ownerKey: "github:daniel",
  collaborators: [
    { key: "github:kris", name: "Kris Wong" },
    { key: "github:alex", name: "Alex Morgan" },
  ],
  tags: [{ id: "tag-ui", name: "UI", color: "blue" }],
  tagAvailability: BranchTagAvailability.Available,
};

export const ApprovedDefault: Story = {
  args: { approved: true, items: [APPROVED_ROW] },
};

export const ApprovedAwaitingSync: Story = {
  args: {
    approved: true,
    items: [
      {
        ...APPROVED_ROW,
        id: "approved-awaiting-sync",
        branchName: "agent/embeddings-store-reindex",
        dataState: BranchDataState.AwaitingSync,
      },
      {
        ...APPROVED_ROW,
        id: "approved-ready",
        branchName: "fix/branch-table-accessibility",
        dataState: BranchDataState.Ready,
      },
    ],
  },
};

export const ApprovedUnenriched: Story = {
  args: {
    approved: true,
    items: [
      {
        ...APPROVED_ROW,
        id: "approved-unenriched",
        repo: RENDER_MISSING,
        owner: RENDER_UNATTRIBUTED,
        additions: null,
        deletions: null,
        lastActivityAt: undefined,
        tags: [],
        tagAvailability: BranchTagAvailability.Unavailable,
      },
    ],
  },
};

export const ApprovedManyCollaborators: Story = {
  args: {
    approved: true,
    items: [
      {
        ...APPROVED_ROW,
        collaborators: ["Kris", "Alex", "Sam", "Taylor", "Jordan"].map(
          (name) => ({ key: `github:${name.toLowerCase()}`, name })
        ),
      },
    ],
  },
};

export const ApprovedTagsReadOnly: Story = {
  args: { approved: true, items: [APPROVED_ROW], tagsReadOnly: true },
};

// A net-new local branch with no GitHub enrichment: repo identity, PR, checks,
// behind/ahead, and changes all degrade to the empty-value affordance (never 0).
const NET_NEW_LOCAL_ROW: BranchRow = {
  id: "local::wip-no-github",
  branchName: "wip/no-github-enrichment",
  baseBranch: RENDER_MISSING,
  repo: RENDER_MISSING,
  owner: RENDER_UNATTRIBUTED,
  status: BranchRowStatus.Draft,
  prNumber: null,
  prTitle: null,
  prUrl: null,
  prState: null,
  checksPassed: null,
  checksTotal: null,
  checksStatus: null,
  behind: null,
  ahead: null,
  additions: null,
  deletions: null,
  sessionCount: 2,
  commentCount: null,
  lastActivityLabel: "10m ago",
};

export const MissingGitHubData: Story = {
  args: { items: [NET_NEW_LOCAL_ROW, ...BRANCH_SAMPLE_ROWS.slice(0, 2)] },
  render: (args) => (
    <main className="h-[400px] overflow-auto">
      <BranchesTable {...args} />
    </main>
  ),
};

/** Table driven by the shared `BranchesToolbar` (Filter + View) + header sort. */
export const WithToolbar: Story = {
  args: { items: BRANCH_SAMPLE_ROWS },
  render: () => <WithToolbarStory />,
};

function WithToolbarStory() {
  const {
    sortKey,
    sortDir,
    dateRange,
    visibleColumns,
    setSort,
    setDateRange,
    toggleColumn,
  } = useBranchViewState();
  const sortedRows = useMemo(
    () => sortBranchRows(BRANCH_SAMPLE_ROWS, sortKey, sortDir),
    [sortKey, sortDir]
  );
  const { filters, pagedRows, handleFiltersChange } =
    useBranchFilterState(sortedRows);

  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);

  return (
    <div className="flex flex-col gap-3 p-3">
      <BranchesToolbar
        dateRange={dateRange}
        filters={filters}
        onDateRangeChange={setDateRange}
        onFiltersChange={handleFiltersChange}
        onToggleColumn={toggleColumn}
        rows={BRANCH_SAMPLE_ROWS}
        visibleColumns={visibleColumns}
      />
      <main className="h-[400px] overflow-auto">
        <BranchesTable
          items={pagedRows}
          onSort={handleSort}
          sortBy={sortKey}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
        />
      </main>
    </div>
  );
}
