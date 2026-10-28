import {
  LINKED_WORK_DATA_PENDING,
  LINKED_WORK_FIELD_SOURCES,
  LinkedWorkCard,
} from "@repo/app/issues/components/linked-work/linked-work-card";
import {
  BRANCH_CLOSED,
  BRANCH_IN_PROGRESS,
  BRANCH_IN_REVIEW,
  BRANCH_MERGED,
  BRANCH_ON_SUB_ISSUE,
  BRANCH_UNCONFIRMED,
} from "@repo/app/issues/components/linked-work/linked-work-card.fixtures";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

// The Issue Detail page's Branch section (ISS-12580, DI-10): on the issue
// canvas below the Sub-issues and above the Activity summary (Ottilie,
// 2026-10-21). A minimal preview that helps decide whether to open the
// branch: its state, read from its pull request (In progress, In review,
// Merged, Closed without merge), its pull request, its test checks and its
// lines changed. The branch name opens the shipped Branch screen. The
// description and the Storybook preview say "Data pending" until their
// source and import rules are known (Nerys is confirming them with Cosimo).
// Sessions, documents and other links are not here. The Data Sources story
// labels every field with where its data comes from.
// The finished page is Surfaces/Labs/Issues/Issue Detail.
//
// Controls table:
// | Prop | Control | Why |
// |---|---|---|
// No-control table:
// | Prop | Reason |
// |---|---|
// | branches | fixture branches; each story picks the state it shows |
// | showSources | engineering annotation; the Data Sources story turns it on |

const meta = {
  title: "Composites/Labs/Issues/Issue Detail/Linked Work Card",
  component: LinkedWorkCard,
  tags: ["preview"],
  parameters: { layout: "padded", controls: { disable: true } },
  args: {
    branches: [BRANCH_IN_REVIEW],
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LinkedWorkCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A branch in review: its pull request, checks and lines changed. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("In review")).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: BRANCH_IN_REVIEW.name })
    ).toBeVisible();
    await expect(canvas.getAllByText(LINKED_WORK_DATA_PENDING)).toHaveLength(2);
  },
};

/** For engineering: every field labelled with its data source. */
export const DataSources: Story = {
  args: {
    branches: [BRANCH_IN_REVIEW, BRANCH_ON_SUB_ISSUE],
    showSources: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByText(LINKED_WORK_FIELD_SOURCES.checks)[0]
    ).toBeVisible();
  },
};

/** A branch with no pull request yet. */
export const InProgress: Story = {
  args: { branches: [BRANCH_IN_PROGRESS] },
};

/** The pull request merged. */
export const Merged: Story = {
  args: { branches: [BRANCH_MERGED] },
};

/** The pull request closed without merging. */
export const ClosedWithoutMerge: Story = {
  args: { branches: [BRANCH_CLOSED] },
};

/** A pull request nobody has observed: the chip and the badge both say so. */
export const Unconfirmed: Story = {
  args: { branches: [BRANCH_UNCONFIRMED] },
};

/**
 * More than one branch: an earlier attempt that closed, the branch in
 * review, and a branch that implements a sub-issue. None collapses.
 */
export const MultipleBranches: Story = {
  args: { branches: [BRANCH_IN_REVIEW, BRANCH_ON_SUB_ISSUE, BRANCH_CLOSED] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      within(canvas.getByRole("list", { name: "Branches" })).getAllByRole(
        "article"
      )
    ).toHaveLength(3);
  },
};

/** No branch yet: the card says so. */
export const NoBranchYet: Story = {
  args: { branches: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No branch yet")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { branches: [BRANCH_IN_REVIEW, BRANCH_ON_SUB_ISSUE] },
  globals: { theme: "dark" },
};
