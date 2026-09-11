import type { Meta, StoryObj } from "@storybook/react";
import { ToolResultBlock } from "./tool-result-block";

/**
 * A collapsible block for a single tool result on its own, with no call to
 * pair it with: a header shows a pass or fail icon and how many lines the
 * output has, and opening it reveals the raw output as plain monospace text.
 * Reach for it when all you have is a result and not the tool call that
 * produced it, since it makes no attempt to format the content the way Tool
 * Call Block does for a matched call and result. An error result turns the
 * whole block red, and a successful one turns it green.
 */
const meta = {
  title: "Composites/Sessions/Trace/Tool Result Block",
  component: ToolResultBlock,
  tags: ["autodocs"],
  argTypes: {
    result: { control: "object" },
    defaultExpanded: { control: "boolean" },
  },
  parameters: { layout: "padded" },
  args: {
    result: {
      type: "tool_result",
      id: "tool-fallback",
      output:
        "Located RunSession, ConfigCard, StatusPill, TokenMeter, and the active-runs/history surfaces in the upstream page.",
      isError: false,
    },
    defaultExpanded: true,
  },
} satisfies Meta<typeof ToolResultBlock>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
