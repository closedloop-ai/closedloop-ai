import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { CollapsedCommentRow } from "@repo/design-system/components/ui/collapsed-comment-row";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A single-line button that stands in for a resolved comment thread: an
 * avatar, the author's name, a status like "Comment resolved", and an
 * optional thread title, all truncated to one row. Use it wherever a full
 * Comment Thread would take up too much space once a conversation is
 * settled, such as a list of resolved discussions. Clicking it does not
 * resolve or reply to anything; it only calls back to expand the row into
 * the full thread.
 */
const meta = {
  title: "Primitives/Content/Collapsed Comment Row",
  component: CollapsedCommentRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    author: { control: "text" },
    title: {
      control: "text",
      description: "Optional thread title appended after the author.",
    },
    statusLabel: { control: "text" },
    avatar: { control: false },
    onExpand: { control: false, table: { category: "Events" } },
  },
  args: {
    author: "Annie Case",
    avatar: (
      <Avatar className="h-6 w-6">
        <AvatarFallback>AC</AvatarFallback>
      </Avatar>
    ),
    onExpand: fn(),
    statusLabel: "Comment resolved",
    title: "Clarify rollout sequencing",
  },
} satisfies Meta<typeof CollapsedCommentRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutTitle: Story = {
  args: {
    title: null,
  },
};
