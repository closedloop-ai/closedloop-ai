import {
  buildTableRangeReadout,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

/**
 * The v2 pagination strip (ISS-7052 Part A).
 *
 * It has TWO layouts, and only one of them was ever visible here. Given neither
 * `readout` nor a rows-per-page pair it degrades to the bare `Pagination` row
 * the v1 strip renders; given either, it switches to a justified band with the
 * readout and the page-size select on the left and the pager on the right.
 *
 * That second layout is the one the stories below exist for. It is a wrapping
 * flex band whose left group grows with the readout's own text, so how it holds
 * up is a question about CROWDING that no assertion answers — a test can prove
 * the readout and the select both rendered while they sit on top of each other.
 * The design-system guardrail asks a new visual mode to be visible here for
 * exactly that reason (davetho review, PR #5940).
 *
 * `table-pagination.tsx` (Primitives) is the superseded v1 pager; ISS-11412
 * moved every caller but `install-matrix.tsx` to this one, and ISS-11264
 * deletes it. Both files export a symbol named `TablePagination`.
 */
const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Pagination V2",
  tags: ["deprecated"],
  component: TablePagination,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof TablePagination>;

export default meta;

type Story = StoryObj<typeof meta>;

const SESSIONS_NOUN = "sessions";

/**
 * Satisfies each story's `args` type. Every story renders through its own
 * stateful harness, so nothing reads this at runtime.
 */
const DUMMY_PAGINATION_V2_ARGS = {
  page: 0,
  totalPages: 1,
  onPageChange: () => undefined,
};

/**
 * The combined branch at a comfortable width: readout, rows-per-page select and
 * pager on one line. Both controls are live, so changing the page size re-reads
 * the range rather than leaving a stale one beside a moved list.
 */
export const ReadoutAndPageSize: Story = {
  args: DUMMY_PAGINATION_V2_ARGS,
  render: () => {
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(
      TABLE_PAGE_SIZE_OPTIONS[0]
    );
    const total = 240;
    return (
      <TablePagination
        onPageChange={setPage}
        onPageSizeChange={(next) => {
          // Same reset the real hosts owe: keeping the index would move the
          // reader to a row they never asked for (see `handlePageSizeChange`).
          setPageSize(next);
          setPage(0);
        }}
        page={page}
        pageSize={pageSize}
        readout={buildTableRangeReadout({
          noun: SESSIONS_NOUN,
          page,
          pageSize,
          total,
        })}
        totalPages={Math.ceil(total / pageSize)}
      />
    );
  },
};

/**
 * The same branch in a narrow column. The band wraps rather than letting the
 * pager overrun the readout — the case the layout is most likely to lose.
 */
export const ReadoutAndPageSizeNarrow: Story = {
  args: DUMMY_PAGINATION_V2_ARGS,
  render: () => {
    const [page, setPage] = useState(3);
    const [pageSize, setPageSize] = useState<number>(
      TABLE_PAGE_SIZE_OPTIONS[0]
    );
    const total = 240;
    return (
      <div className="max-w-sm">
        <TablePagination
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(0);
          }}
          page={page}
          pageSize={pageSize}
          readout={buildTableRangeReadout({
            noun: SESSIONS_NOUN,
            page,
            pageSize,
            total,
          })}
          totalPages={Math.ceil(total / pageSize)}
        />
      </div>
    );
  },
};

/**
 * A long readout beside a deep pager — six-figure totals plus the ellipsis
 * windowing, which is where the left group is widest and the two can collide.
 */
export const LongReadout: Story = {
  args: DUMMY_PAGINATION_V2_ARGS,
  render: () => {
    const [page, setPage] = useState(412);
    const [pageSize, setPageSize] = useState<number>(
      TABLE_PAGE_SIZE_OPTIONS[0]
    );
    const total = 128_450;
    return (
      <TablePagination
        onPageChange={setPage}
        onPageSizeChange={(next) => {
          setPageSize(next);
          setPage(0);
        }}
        page={page}
        pageSize={pageSize}
        readout={buildTableRangeReadout({
          noun: SESSIONS_NOUN,
          page,
          pageSize,
          total,
        })}
        totalPages={Math.ceil(total / pageSize)}
      />
    );
  },
};

/**
 * The readout ALONE — no rows-per-page pair. Still the justified band, and the
 * readout takes the larger `text-sm` it uses when it is not sharing the group,
 * which is the one styling difference between the two arms.
 */
export const ReadoutOnly: Story = {
  args: DUMMY_PAGINATION_V2_ARGS,
  render: () => {
    const [page, setPage] = useState(0);
    const pageSize = TABLE_PAGE_SIZE_OPTIONS[0];
    const total = 240;
    return (
      <TablePagination
        onPageChange={setPage}
        page={page}
        readout={buildTableRangeReadout({
          noun: SESSIONS_NOUN,
          page,
          pageSize,
          total,
        })}
        totalPages={Math.ceil(total / pageSize)}
      />
    );
  },
};

/**
 * `disabled` (ISS-11412): every control stays mounted but locked, the state a
 * list footer holds while a placeholder page is on screen. Shown in the
 * combined branch so the rows-per-page select's locked state is visible too.
 * No controls: a fixed-state story, like its siblings, whose whole point is the
 * one locked state.
 */
export const Disabled: Story = {
  args: DUMMY_PAGINATION_V2_ARGS,
  render: () => {
    const pageSize = TABLE_PAGE_SIZE_OPTIONS[0];
    const total = 240;
    const page = 3;
    return (
      <TablePagination
        disabled
        onPageChange={() => undefined}
        onPageSizeChange={() => undefined}
        page={page}
        pageSize={pageSize}
        readout={buildTableRangeReadout({
          noun: SESSIONS_NOUN,
          page,
          pageSize,
          total,
        })}
        totalPages={Math.ceil(total / pageSize)}
      />
    );
  },
};
