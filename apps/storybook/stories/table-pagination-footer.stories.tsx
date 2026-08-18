import { TablePaginationFooter } from "@repo/design-system/components/ui/table-pagination-footer";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * The shared paginated-table footer (ISS-4681): a `border-t` strip with an
 * optional `role="status"` range readout and the shared `TablePagination`
 * control. Used by My Tasks, Sessions, Branches, and the desktop list views so
 * one queue reads the same way on every surface.
 */
const meta = {
  title: "Design System/Data Display/Table Pagination Footer",
  component: TablePaginationFooter,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof TablePaginationFooter>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One page: the readout still states the range, and no controls render. */
export const SinglePage: Story = {
  render: () => (
    <TablePaginationFooter
      onPageChange={() => {
        // Single page — the control renders nothing, so this never fires.
      }}
      page={0}
      readout="Showing 1-12 of 12 tasks"
      totalPages={1}
    />
  ),
};

/** The common case: a range readout beside live page controls. */
export const MultiPage: Story = {
  render: () => {
    const [page, setPage] = useState(0);
    return (
      <TablePaginationFooter
        onPageChange={setPage}
        page={page}
        readout={`Showing ${page * 25 + 1}-${page * 25 + 25} of 240 tasks`}
        totalPages={10}
      />
    );
  },
};

/** The result set was capped server-side, so the total is not the population. */
export const WithTruncationNote: Story = {
  render: () => {
    const [page, setPage] = useState(2);
    return (
      <TablePaginationFooter
        onPageChange={setPage}
        page={page}
        readout={`Showing ${page * 25 + 1}-${page * 25 + 25} of 500 tasks`}
        totalPages={20}
        truncationNote="Only the 500 most recently updated tasks are listed."
      />
    );
  },
};

/** No readout — a surface with no total it can state honestly. */
export const ControlsOnly: Story = {
  render: () => {
    const [page, setPage] = useState(3);
    return (
      <TablePaginationFooter
        onPageChange={setPage}
        page={page}
        totalPages={8}
      />
    );
  },
};

/**
 * A readout long enough to wrap: the strip stacks below `sm` and the readout
 * must not squeeze the controls off the row.
 */
export const LongReadout: Story = {
  render: () => {
    const [page, setPage] = useState(1);
    return (
      <div className="max-w-md">
        <TablePaginationFooter
          onPageChange={setPage}
          page={page}
          readout="Showing 26-50 of 1,284 branches across every connected repository in this organization"
          totalPages={52}
        />
      </div>
    );
  },
};
