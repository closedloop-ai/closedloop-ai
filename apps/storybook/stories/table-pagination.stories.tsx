import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Button-driven pagination built on the shadcn `Pagination` primitives:
 * Previous / numbered pages (with ellipses) / Next. Calls `onPageChange` with
 * the target zero-based page. Renders nothing for a single page.
 */
const meta = {
  title: "Design System/Data Display/Table Pagination",
  component: TablePagination,
  parameters: {
    layout: "centered",
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
