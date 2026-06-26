import { ConversationMessage } from "@repo/design-system/components/ui/conversation-message";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Conversation Message",
  component: ConversationMessage,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[520px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    content:
      "I found the review thread and replaced the findings artifact with the actual implementation.",
    role: "assistant",
  },
} satisfies Meta<typeof ConversationMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};

export const User: Story = {
  args: {
    content: "Can you make the PR merge-ready and remove the nightly files?",
    role: "user",
  },
};

export const Multiline: Story = {
  args: {
    content:
      "Implemented:\n- Added runtime validation\n- Removed unchecked casts\n- Deleted the findings file",
    role: "assistant",
  },
};
