import type { Meta, StoryObj } from "@storybook/react";
import { ThinkingBlock } from "./thinking-block";

/**
 * A collapsible amber box that shows an agent's reasoning text for one turn,
 * tucked behind a Thinking header so it does not crowd out the actual reply.
 * Collapsed, it shows only a character count; expanded, it renders the full
 * text as formatted markdown. Reach for it any time a trace needs to show an
 * agent's internal reasoning inline, rather than building another expandable
 * text block, so every place reasoning shows up looks the same. If there is
 * no text to show, it renders nothing at all.
 */
const meta = {
  title: "Composites/Sessions/Trace/Thinking Block",
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
