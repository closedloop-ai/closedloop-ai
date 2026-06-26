import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentCollaborationNetwork } from "./agent-collaboration-network";

const AgentCollaborationNetworkCanvas = () => (
  <AgentCollaborationNetwork
    data={workflowData.effectiveness}
    edges={workflowData.cooccurrence}
  />
);

const meta = {
  title: "App Core/Agents/Agent Collaboration Network",
  component: AgentCollaborationNetworkCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentCollaborationNetworkCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
