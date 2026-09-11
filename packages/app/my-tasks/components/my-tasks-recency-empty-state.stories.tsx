import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { MyTasksRecencyEmptyState } from "./my-tasks-recency-empty-state";

// FEA-1626 — the "your work aged out of the window" state.
// Reaching this in the running app needs the recency flag on, an actually-empty
// windowed result, and the chip still in force, so the copy and the escape hatch
// are effectively unreviewable in situ. The story is where a regression in
// either becomes visible: a user back from leave must read that their work is
// still there, and must be able to get to it.
/**
 * The empty state for My Tasks when a recent work only time window is turned
 * on and nothing in your queue falls inside it. It has its own icon,
 * headline, and a Show All button that drops the window and re-checks your
 * full history, because this is a different situation from an actually empty
 * queue. Use it specifically for that case: someone back from time off with
 * no recent activity still has assigned work, and this state says so instead
 * of telling them their queue is clear.
 */
const meta = {
  title: "Composites/My Tasks/Recency Empty State",
  component: MyTasksRecencyEmptyState,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    onShowAll: fn(),
  },
  argTypes: {
    onShowAll: { control: false, table: { category: "Events" } },
  },
} satisfies Meta<typeof MyTasksRecencyEmptyState>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The whole state: the bound named in the title, BOTH exclusions named in the
 * body (older work AND archived projects), and one control back to full history.
 * Compare against the board's default empty state, "Your queue is clear" with
 * the two create buttons, which is the message this one exists to keep off the
 * screen. Both are the catalog `EmptyState`, so swapping between them moves
 * nothing but the copy, the icon, and the action.
 */
export const Default: Story = {};

/**
 * Narrow viewport: the body is the longest string here, so this is where the
 * design-system header measure and the button's spacing get checked.
 */
export const Narrow: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
