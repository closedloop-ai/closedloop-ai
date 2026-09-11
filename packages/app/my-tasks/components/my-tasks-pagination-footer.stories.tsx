import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  MyTasksPagedUnit,
  resolveMyTasksRangeReadout,
  resolveMyTasksTruncation,
} from "../lib/my-tasks-range-readout";
import { MyTasksPaginationFooter } from "./my-tasks-pagination-footer";

/**
 * ISS-4683 — the My Tasks footer's readout/pager combinations, on a canvas.
 *
 * This is the strip both My Tasks views mount, and it is the one part of the
 * screen whose whole job is to make a claim about the user's queue. The states
 * worth seeing side by side are therefore the ones where that claim changes
 * shape rather than changes wording: a single page (where the pager renders
 * nothing and the readout stands alone), a page in the middle of several, and a
 * total that is a floor and so drags a second disclosure line under it.
 *
 * Every sentence here comes from `../lib/my-tasks-range-readout`, the same pure
 * helpers the product calls. A story that hand-typed "Showing 1-50 of 137
 * tasks" would keep rendering the old wording for as long as it took someone to
 * notice, which is precisely the drift this component was consolidated to stop.
 */

const COMPLETE_TOTAL = resolveMyTasksRangeReadout({
  from: 1,
  isTotalPartial: false,
  to: 50,
  total: 137,
  unit: MyTasksPagedUnit.Tasks,
});

const BOUNDED_READ = resolveMyTasksTruncation(500, 620);
const PARTIAL_TOTAL = resolveMyTasksRangeReadout({
  from: 1,
  isTotalPartial: BOUNDED_READ.isTotalPartial,
  to: 50,
  total: 550,
  unit: MyTasksPagedUnit.TopLevelTasks,
});

/**
 * The pager at the bottom of a My Tasks list or board: page controls plus a
 * line of text stating the range you are looking at, like 1 to 20 of 84.
 * Reach for it specifically on My Tasks screens, since it shares its wording
 * with both the list and card views so the two never describe the same queue
 * differently. It can also show a second line noting that the count above it
 * is a lower bound, for when some rows had to be left out.
 */
const meta = {
  title: "Composites/My Tasks/Pagination Footer",
  component: MyTasksPaginationFooter,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    onPageChange: fn(),
    page: 0,
    readout: COMPLETE_TOTAL,
    totalPages: 3,
    truncationNote: null,
  },
  argTypes: {
    onPageChange: { control: false, table: { category: "Events" } },
    page: { control: { type: "number", min: 0, step: 1 } },
    readout: { control: "text" },
    totalPages: { control: { type: "number", min: 1, max: 100, step: 1 } },
    truncationNote: { control: "text" },
  },
  decorators: [
    (Story) => (
      <div className="flex w-full flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MyTasksPaginationFooter>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A whole queue that fits on one page. `TablePagination` renders nothing at
 * `totalPages <= 1`, so the strip is the readout alone — which is the point of
 * mounting this footer unconditionally rather than behind a `totalPages > 1`
 * guard: the reader still gets told what they are looking at.
 */
export const SinglePage: Story = {
  args: {
    readout: resolveMyTasksRangeReadout({
      from: 1,
      isTotalPartial: false,
      to: 12,
      total: 12,
      unit: MyTasksPagedUnit.Tasks,
    }),
    totalPages: 1,
  },
};

/** The first of several pages: Previous is inert, Next is live. */
export const MultiPage: Story = {};

/** Mid-queue, so both directions are live and the window shows its neighbours. */
export const MiddlePage: Story = {
  args: {
    page: 4,
    readout: resolveMyTasksRangeReadout({
      from: 201,
      isTotalPartial: false,
      to: 250,
      total: 1233,
      unit: MyTasksPagedUnit.Tasks,
    }),
    totalPages: 25,
  },
};

/**
 * The total is a FLOOR — the underlying read was bounded (FEA-4373) — so the
 * count is marked `+` and the disclosure naming the bound takes its own line
 * beneath it. The `+` and the note are derived together by
 * `resolveMyTasksTruncation`, so neither can appear here without the other.
 */
export const TruncatedTotal: Story = {
  args: {
    readout: PARTIAL_TOTAL,
    truncationNote: BOUNDED_READ.note,
  },
};

/**
 * The same two lines in a column too narrow to hold them, which is where the
 * readout's own wrapping and the `items-start` alignment earn their keep: the
 * range and its caveat stay left-aligned against each other instead of
 * centering into a ragged block. Below the `sm:` breakpoint the strip also
 * stacks the pager under the readout — resize the canvas to see that half.
 */
export const NarrowColumn: Story = {
  args: {
    readout: PARTIAL_TOTAL,
    truncationNote: BOUNDED_READ.note,
  },
  decorators: [
    (Story) => (
      <div className="flex w-72 flex-col border">
        <Story />
      </div>
    ),
  ],
};
