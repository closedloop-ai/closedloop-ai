import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { CompactionImpact } from "./compaction-impact";

const CompactionImpactCanvas = () => (
  <CompactionImpact data={workflowData.compaction} />
);

const meta = {
  title: "Composites v1.0/Agents/General/Compaction Impact",
  component: CompactionImpactCanvas,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof CompactionImpactCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
