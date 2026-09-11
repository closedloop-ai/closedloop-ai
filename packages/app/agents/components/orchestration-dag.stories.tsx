import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { OrchestrationDag } from "./orchestration-dag";

const OrchestrationDagCanvas = () => (
  <OrchestrationDag data={workflowData.orchestration} />
);

/**
 * A layered flow diagram that traces work through the whole system: sessions
 * arrive on the left, flow into the main agent, branch out to each subagent
 * type, pass through any context-trimming compactions, and land on a final
 * outcome such as completed or failed. Each box shows how many instances
 * passed through it, and the connecting lines thicken with volume, with
 * badges below totaling the outcomes and compactions. Use this for the
 * workflow-level view across many sessions. For one session's own chain of
 * delegation, use the Session Detail Orchestration Graph instead, which is a
 * different chart built for a single record.
 */
const meta = {
  title: "Composites/Agents/Agent Orchestration Graph",
  component: OrchestrationDagCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof OrchestrationDagCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
