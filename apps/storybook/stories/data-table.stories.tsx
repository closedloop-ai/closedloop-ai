import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import {
  type MockProjectRow,
  mockProjectRows,
} from "@repo/design-system/storybook/mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { action } from "storybook/actions";

const columns: Column<MockProjectRow>[] = [
  {
    key: "name",
    header: "Project",
    sortable: true,
  },
  {
    key: "owner",
    header: "Owner",
    sortable: true,
  },
  {
    key: "status",
    header: "Status",
    sortable: true,
    render: (item) => <Badge variant="outline">{item.status}</Badge>,
  },
  {
    key: "updatedAt",
    header: "Updated",
    sortable: true,
  },
];

type ProjectDataTableProps = {
  data: MockProjectRow[];
  columns: Column<MockProjectRow>[];
  searchPlaceholder?: string;
  searchKey?: keyof MockProjectRow;
  sortOptions?: SortOption[];
  filterOptions?: FilterOption[];
  filterKey?: keyof MockProjectRow;
  onRowClick?: (item: MockProjectRow) => void;
  rowHref?: (item: MockProjectRow) => string | undefined;
  renderRowActions?: (item: MockProjectRow) => ReactNode;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  emptyMessage?: string;
};

const ProjectDataTable = (props: ProjectDataTableProps) => (
  <DataTable<MockProjectRow> {...props} />
);

const meta = {
  title: "Design System/Data Display/Data Table",
  component: ProjectDataTable,
  tags: ["autodocs"],
  args: {
    data: mockProjectRows,
    columns,
    searchKey: "name",
    searchPlaceholder: "Search projects...",
    filterKey: "status",
    filterOptions: [
      { label: "Active", value: "Active" },
      { label: "Backlog", value: "Backlog" },
      { label: "Paused", value: "Paused" },
    ],
    sortOptions: [
      { label: "Updated (newest)", value: "updatedAt:desc" },
      { label: "Project name", value: "name:asc" },
    ],
    renderRowActions: (item: MockProjectRow) => (
      <Button
        onClick={() => action("row-action")(item)}
        size="sm"
        variant="ghost"
      >
        Open
      </Button>
    ),
    onRowClick: (item: MockProjectRow) => action("row-click")(item),
  },
} satisfies Meta<typeof ProjectDataTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
