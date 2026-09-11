import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentPipelineGraph } from "./agent-pipeline-graph";

const AgentPipelineGraphCanvas = () => (
  <AgentPipelineGraph
    data={workflowData.effectiveness}
    edges={workflowData.cooccurrence}
  />
);

/**
 * A ready made dashboard tile showing which agent types hand work to which
 * others, built on the generic Graph primitive.
 */
const meta = {
  title: "Primitives/Charts/Agent Pipeline Graph",
  component: AgentPipelineGraphCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentPipelineGraphCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
