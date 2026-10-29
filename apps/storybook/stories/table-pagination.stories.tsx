import { TablePagination } from "@repo/design-system/components/ui/table-pagination";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * Button-driven pagination built on the shadcn `Pagination` primitives:
 * Previous / numbered pages (with ellipses) / Next. Calls `onPageChange` with
 * the target zero-based page. Renders nothing for a single page.
 *
 * `table-pagination-v2.tsx` is a separate component for the Grid Table V2
 * toolbar (its own story: "Composites/Data Display/Tables/Table Pagination
 * V2") — both files export a symbol named `TablePagination`, but they are two
 * distinct components, not two versions of one.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Tables/Table Pagination",
  component: TablePagination,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TablePagination>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Satisfies each story's `args` type. Every story renders through its own
 * stateful harness, so nothing reads this at runtime.
 */
const DUMMY_PAGINATION_ARGS = {
  page: 0,
  totalPages: 1,
  onPageChange: () => undefined,
};

/** Many pages — exercises the ellipsis windowing. */
export const ManyPages: Story = {
  args: DUMMY_PAGINATION_ARGS,
  render: () => {
    const [page, setPage] = useState(6);
    return (
      <TablePagination onPageChange={setPage} page={page} totalPages={458} />
    );
  },
};

/** A handful of pages — no ellipses. */
export const FewPages: Story = {
  args: DUMMY_PAGINATION_ARGS,
  render: () => {
    const [page, setPage] = useState(0);
    return (
      <TablePagination onPageChange={setPage} page={page} totalPages={4} />
    );
  },
};
