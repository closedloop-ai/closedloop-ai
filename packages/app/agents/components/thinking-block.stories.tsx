import type { Meta, StoryObj } from "@storybook/react";
import { ThinkingBlock } from "./thinking-block";

const meta = {
  title: "App Core/Agents/Overview/Thinking Block",
  component: ThinkingBlock,
  tags: ["autodocs"],
  argTypes: {
    text: { control: "text" },
    defaultExpanded: { control: "boolean" },
  },
  parameters: { layout: "padded" },
  args: {
    text: "The right merge boundary is a shared card primitive plus page-level composition, not another monitor-only wrapper.",
    defaultExpanded: false,
  },
} satisfies Meta<typeof ThinkingBlock>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Expanded: Story = { args: { defaultExpanded: true } };
