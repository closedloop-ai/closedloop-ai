import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { CollapsedCommentRow } from "@repo/design-system/components/ui/collapsed-comment-row";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

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
