import { SortableColumnHeader } from "@repo/design-system/components/ui/sortable-column-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import type { Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";

type SortColumn = "name" | "updatedAt";

const rows = [
  { name: "Agent monitor extraction", updatedAt: "2026-05-29 09:40" },
  { name: "Storybook backfill", updatedAt: "2026-05-29 11:12" },
];

function SortableColumnHeaderDemo({
  initialSortBy = "name",
  initialSortDir = "desc",
}: {
  initialSortBy?: SortColumn | null;
  initialSortDir?: "asc" | "desc";
}) {
  const [sortBy, setSortBy] = useState<SortColumn | null>(initialSortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);

  const sortedRows = useMemo(() => {
    const nextRows = [...rows];

    if (!sortBy) {
      return nextRows;
    }

    nextRows.sort((left, right) => {
      const leftValue = left[sortBy];
      const rightValue = right[sortBy];
      const comparison = leftValue.localeCompare(rightValue);
      return sortDir === "asc" ? comparison : -comparison;
    });

    return nextRows;
  }, [sortBy, sortDir]);

  return (
    <div className="space-y-3">
      <div className="text-muted-foreground text-sm">
        Current sort:{" "}
        <span className="font-medium text-foreground">
          {sortBy ? `${sortBy} (${sortDir})` : "none"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableColumnHeader
              column="name"
              label="Name"
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              sortBy={sortBy}
              sortDir={sortDir}
            />
            <SortableColumnHeader
              className="text-right"
              column="updatedAt"
              label="Updated"
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row) => (
            <TableRow key={row.name}>
              <TableCell>{row.name}</TableCell>
              <TableCell className="text-right">{row.updatedAt}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const meta = {
  title: "Design System/Primitives/Sortable Column Header",
  component: SortableColumnHeaderDemo,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof SortableColumnHeaderDemo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Unsorted: Story = {
  args: {
    initialSortBy: null,
  },
};

export const Ascending: Story = {
  args: {
    initialSortBy: "updatedAt",
    initialSortDir: "asc",
  },
};
