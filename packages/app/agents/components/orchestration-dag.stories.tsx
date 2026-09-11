import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { OrchestrationDag } from "./orchestration-dag";

const OrchestrationDagCanvas = () => (
  <OrchestrationDag data={workflowData.orchestration} />
);

/**
 * Traces sessions flowing into the main agent, out to subagents, and through
 * compactions to an outcome, for the workflow view across many sessions
 * rather than one.
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
