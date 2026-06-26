import type { Meta, StoryObj } from "@storybook/react";
import { ToolResultBlock } from "./tool-result-block";

const meta = {
  title: "App Core/Agents/Tool Result Block",
  component: ToolResultBlock,
  tags: ["autodocs"],
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
