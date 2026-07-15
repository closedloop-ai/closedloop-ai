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
