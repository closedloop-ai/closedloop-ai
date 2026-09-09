import { runSessionRecord } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { ToolCallBlock } from "./tool-call-block";

const assistantMessage = runSessionRecord.transcript.messages[1]!;
const toolUse = assistantMessage.blocks?.find(
  (block) => block.type === "tool_use"
);

const meta = {
  title: "App Core/Agents/Tools/Tool Call Block",
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
