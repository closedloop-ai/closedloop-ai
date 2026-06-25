import { Priority } from "@repo/api/src/types/common";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import {
  TableViewMenu,
  type TableViewMenuColumn,
  type TableViewMode,
} from "@repo/design-system/components/ui/table-view-menu";
import type { Meta, StoryObj } from "@storybook/react";
import {
  BadgeCheckIcon,
  CalendarIcon,
  FileIcon,
  FolderIcon,
  ListTreeIcon,
  RefreshCwIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";

const initialColumns: TableViewMenuColumn[] = [
  {
    id: "type",
    icon: <FileIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Type",
    visible: true,
  },
  {
    id: "assignee",
    icon: <UserIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Assignee",
    visible: true,
  },
  {
    id: "loop",
    icon: <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Loop",
    visible: false,
  },
  {
    id: "parent",
    icon: <ListTreeIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Parent",
    visible: true,
  },
  {
    id: "priority",
    icon: <PriorityIcon priority={Priority.Medium} size={16} />,
    label: "Priority",
    visible: true,
  },
  {
    id: "score",
    icon: <BadgeCheckIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Quality Score",
    visible: true,
  },
  {
    id: "updated",
    icon: <CalendarIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Updated",
    visible: true,
  },
  {
    id: "project",
    icon: <FolderIcon className="h-4 w-4 text-muted-foreground" />,
    label: "Project",
    visible: false,
  },
];

const groupByOptions = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
];

function TableViewMenuDemo() {
  const [columns, setColumns] = useState(initialColumns);
  const [groupByValue, setGroupByValue] = useState("status");
  const [view, setView] = useState<TableViewMode>("list");

  return (
    <TableViewMenu
      columns={columns}
      groupByOptions={groupByOptions}
      groupByValue={groupByValue}
      onChangeGroupBy={setGroupByValue}
      onChangeView={setView}
      onResetView={() => {
        setColumns(initialColumns);
        setGroupByValue("none");
        setView("list");
      }}
      onToggleColumn={(columnId) =>
        setColumns((current) =>
          current.map((column) =>
            column.id === columnId
              ? { ...column, visible: !column.visible }
              : column
          )
        )
      }
      view={view}
    />
  );
}

const meta = {
  title: "Design System/Primitives/Table View Menu",
  component: TableViewMenuDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TableViewMenuDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ColumnsOnly: Story = {
  render: () => {
    const [columns, setColumns] = useState(initialColumns);

    return (
      <TableViewMenu
        columns={columns}
        onToggleColumn={(columnId) =>
          setColumns((current) =>
            current.map((column) =>
              column.id === columnId
                ? { ...column, visible: !column.visible }
                : column
            )
          )
        }
      />
    );
  },
};

export const EmptyColumns: Story = {
  render: () => (
    <TableViewMenu
      columns={[]}
      groupByOptions={groupByOptions}
      groupByValue="none"
      onChangeGroupBy={() => undefined}
      onChangeView={() => undefined}
      onResetView={() => undefined}
      onToggleColumn={() => undefined}
      view="list"
    />
  ),
};
