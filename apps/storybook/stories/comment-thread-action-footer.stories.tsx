import { CommentThreadActionFooter } from "@repo/design-system/components/ui/comment-thread-action-footer";
import type { Meta, StoryObj } from "@storybook/react";
import { CheckCheck } from "lucide-react";
import { fn } from "storybook/test";

const meta = {
  title: "Design System/Documents & Conversation/Comment Thread Action Footer",
  component: CommentThreadActionFooter,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    label: { control: "text" },
    isPending: {
      control: "boolean",
      description: "Disables the button while the action is in flight.",
    },
    icon: {
      control: false,
      description: "Optional node rendered before the label.",
    },
    onClick: { control: false, table: { category: "Events" } },
  },
  args: {
    icon: <CheckCheck className="mr-1.5 h-3.5 w-3.5" />,
    isPending: false,
    label: "Resolve Conversation",
    onClick: fn(),
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
