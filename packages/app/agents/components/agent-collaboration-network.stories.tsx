import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentCollaborationNetwork } from "./agent-collaboration-network";

const AgentCollaborationNetworkCanvas = () => (
  <AgentCollaborationNetwork
    data={workflowData.effectiveness}
    edges={workflowData.cooccurrence}
  />
);

/**
 * A node-and-edge diagram showing which agent types hand work off to which
 * others, sized by how often each type runs and how heavily two types are
 * linked. Hover a node or a connecting line to see its run count, session
 * count, and success rate. Reach for it when you want the overall pattern of
 * collaboration across many sessions, rather than the play-by-play of a
 * single session, which is what the orchestration graph shows instead. It
 * renders an empty message rather than a blank chart when there is no
 * collaboration data for the selected period.
 */
const meta = {
  title: "Composites/Agents/Agent Collaboration Network",
  component: AgentCollaborationNetworkCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AgentCollaborationNetworkCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
