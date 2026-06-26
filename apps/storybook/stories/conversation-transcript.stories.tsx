import {
  type ConversationMessageItem,
  ConversationTranscript,
} from "@repo/design-system/components/ui/conversation-transcript";
import type { Meta, StoryObj } from "@storybook/react";

const messages: ConversationMessageItem[] = [
  {
    id: "m1",
    role: "assistant",
    content:
      "I found two unresolved rollout comments on the branch. The riskiest one is still missing a rollback owner.",
  },
  {
    id: "m2",
    role: "user",
    content: "Summarize the missing pieces and draft a reply I can post.",
  },
  {
    id: "m3",
    role: "assistant",
    content:
      "The thread needs rollback ownership, verification steps, and an explicit deploy window. I can draft a concise response covering all three.",
  },
];

const meta = {
  title: "Design System/Documents & Conversation/Conversation Transcript",
  component: ConversationTranscript,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    className: "max-w-2xl rounded-lg border bg-background p-4",
    messages,
  },
} satisfies Meta<typeof ConversationTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
