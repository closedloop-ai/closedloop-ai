import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentPipelineGraph } from "./agent-pipeline-graph";

const AgentPipelineGraphCanvas = () => (
  <AgentPipelineGraph
    data={workflowData.effectiveness}
    edges={workflowData.cooccurrence}
  />
);

const meta = {
  title: "App Core/Agents/Agent Pipeline Graph",
  component: AgentPipelineGraphCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentPipelineGraphCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
