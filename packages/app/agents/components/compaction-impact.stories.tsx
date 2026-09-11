import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { CompactionImpact } from "./compaction-impact";

const CompactionImpactCanvas = () => (
  <CompactionImpact data={workflowData.compaction} />
);

/**
 * Summarizes how often context compaction ran and how many tokens it
 * recovered, broken down by session, leaving the token trend over time to a
 * separate chart.
 */
const meta = {
  title: "Composites/Agents/Compaction Impact",
  component: CompactionImpactCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof CompactionImpactCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
