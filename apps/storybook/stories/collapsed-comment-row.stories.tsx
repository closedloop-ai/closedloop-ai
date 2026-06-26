import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { CollapsedCommentRow } from "@repo/design-system/components/ui/collapsed-comment-row";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Documents & Conversation/Collapsed Comment Row",
  component: CollapsedCommentRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    author: "Annie Case",
    avatar: (
      <Avatar className="h-6 w-6">
        <AvatarFallback>AC</AvatarFallback>
      </Avatar>
    ),
    onExpand: () => undefined,
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
