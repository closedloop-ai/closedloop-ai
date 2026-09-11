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
 * A node-and-line diagram showing which agent types hand work to which
 * others and how often, with its own heading and caption built in above the
 * diagram. It is a ready-made dashboard tile built on the generic Graph
 * primitive: reach for Graph directly when you need a node-link diagram for
 * other data, and for Sankey Graph when the relative volume flowing between
 * stages matters more than the individual connections. It always renders the
 * same "Agent Collaboration Network" title and description, so it is not
 * meant to be relabeled or reused for a different dataset.
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
