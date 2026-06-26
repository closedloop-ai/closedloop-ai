import { CommentThreadActionFooter } from "@repo/design-system/components/ui/comment-thread-action-footer";
import type { Meta, StoryObj } from "@storybook/react";
import { CheckCheck } from "lucide-react";

const meta = {
  title: "Design System/Documents & Conversation/Comment Thread Action Footer",
  component: CommentThreadActionFooter,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    icon: <CheckCheck className="mr-1.5 h-3.5 w-3.5" />,
    label: "Resolve Conversation",
    onClick: () => undefined,
  },
} satisfies Meta<typeof CommentThreadActionFooter>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Resolve: Story = {};

export const Pending: Story = {
  args: {
    isPending: true,
    label: "Unresolve Conversation",
  },
};

export const WithoutIcon: Story = {
  args: {
    icon: undefined,
    label: "Retry Resolution",
  },
};
