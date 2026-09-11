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

/**
 * A vertical stack of Conversation Message bubbles built from a plain list
 * of messages, each needing only an id, a role, and its text. Reach for it
 * whenever you have more than one exchange to show and want the spacing
 * between bubbles handled for you, rather than assembling Conversation
 * Message instances by hand. It renders as a log region for assistive
 * technology, but it does not scroll or paginate on its own, so wrap it in a
 * scrolling container for long conversations.
 */
const meta = {
  title: "Primitives/Content/Conversation Transcript",
  component: ConversationTranscript,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    messages: {
      control: "object",
      description:
        "Ordered transcript entries. Each needs an id, a role and content.",
    },
    className: { control: "text" },
  },
  args: {
    className: "max-w-2xl rounded-lg border bg-background p-4",
    messages,
  },
} satisfies Meta<typeof ConversationTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
