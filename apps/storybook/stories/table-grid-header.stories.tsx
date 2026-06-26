import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import {
  TableGridHeader,
  type TableGridHeaderColumn,
} from "@repo/design-system/components/ui/table-grid-header";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const columns: TableGridHeaderColumn[] = [
  { id: "status", label: "Status", sortable: true },
  { id: "assignee", label: "Assignee", sortable: true },
  { id: "priority", label: "Priority", sortable: true },
  { id: "updatedAt", label: "Updated", sortable: true },
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

  return (
    <div className="overflow-x-auto rounded-md border">
      <TableGridHeader
        allSelected={allSelected}
        columns={visibleColumns}
        gridTemplateColumns={`minmax(280px,1fr) repeat(${visibleColumns.length},124px)`}
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

export const Default: Story = {};

export const SimpleNameSort: Story = {
  args: {
    withNameSortOptions: false,
  },
};

export const MinimalColumns: Story = {
  args: {
    visibleColumns: columns.slice(0, 2),
    showSelectAll: false,
    someSelected: false,
  },
};
