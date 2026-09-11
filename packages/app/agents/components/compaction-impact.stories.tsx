import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { CompactionImpact } from "./compaction-impact";

const CompactionImpactCanvas = () => (
  <CompactionImpact data={workflowData.compaction} />
);

/**
 * A summary panel about context compaction, the process that trims a
 * session's context so it can keep running. Two stat cards total how many
 * compactions happened and how many tokens they recovered, and a ranked bar
 * list below breaks that down session by session so you can see which
 * sessions leaned on compaction the most. It only covers compaction counts,
 * not the token trend over time, which lives in a separate chart.
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
