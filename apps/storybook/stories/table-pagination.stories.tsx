import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

/**
 * Button-driven pagination built on the shadcn `Pagination` primitives:
 * Previous / numbered pages (with ellipses) / Next. Calls `onPageChange` with
 * the target zero-based page. Renders nothing for a single page.
 */
const meta = {
  title: "Design System/Data Display/Table Pagination",
  component: TablePagination,
  tags: ["autodocs"],
  argTypes: {
    page: {
      control: { type: "number", min: 0, max: 500, step: 1 },
      description: "Zero-based current page index.",
    },
    totalPages: {
      control: { type: "number", min: 1, max: 500, step: 1 },
      description: "Renders nothing at 1 or below.",
    },
    className: { control: "text" },
    onPageChange: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    page: 6,
    totalPages: 458,
    onPageChange: fn(),
  },
} satisfies Meta<typeof TablePagination>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Many pages — exercises the ellipsis windowing. */
export const ManyPages: Story = {
  render: () => {
    const [page, setPage] = useState(6);
    return (
      <TablePagination onPageChange={setPage} page={page} totalPages={458} />
    );
  },
};

/** A handful of pages — no ellipses. */
export const FewPages: Story = {
  render: () => {
    const [page, setPage] = useState(0);
    return (
      <TablePagination onPageChange={setPage} page={page} totalPages={4} />
    );
  },
};
