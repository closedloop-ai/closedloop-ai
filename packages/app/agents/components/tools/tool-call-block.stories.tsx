import { runSessionRecord } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { ToolCallBlock } from "./tool-call-block";

const assistantMessage = runSessionRecord.transcript.messages[1]!;
const toolUse = assistantMessage.blocks?.find(
  (block) => block.type === "tool_use"
);

/**
 * A collapsible card for one tool call and its result together: a colored
 * icon and label identify the tool, such as a shell command, a file edit, or
 * a search, a one line summary shows the file path or command at a glance,
 * and a small badge marks it complete or errored. Opening the card formats
 * the input and result to match the tool, for example a terminal block for a
 * shell command or a red and green diff for an edit. Reach for it when you
 * want the whole call, in and out, as one unit; use Tool Result Block
 * instead if you only have a result and no matching call, or Tool Data View
 * if you want just the formatted input or response without the surrounding
 * card.
 */
const meta = {
  title: "Composites/Sessions/Trace/Tool Call Block",
  component: ToolCallBlock,
  tags: ["autodocs"],
  argTypes: {
    toolUse: { control: "object" },
    toolResult: { control: "object" },
  },
  parameters: { layout: "padded" },
  args: {
    toolUse,
    toolResult: null,
  },
} satisfies Meta<typeof ToolCallBlock>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
