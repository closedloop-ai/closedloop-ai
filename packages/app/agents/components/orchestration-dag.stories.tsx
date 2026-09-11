import { workflowData } from "@repo/app/agents/lib/session-mock-data";
import type { Meta, StoryObj } from "@storybook/react";
import { OrchestrationDag } from "./orchestration-dag";

/**
 * Traces sessions flowing into the main agent, out to subagents, and through
 * compactions to an outcome, for the workflow view across many sessions
 * rather than one.
 */
const meta = {
  title: "Composites/Agents/Agent Orchestration Graph",
  component: OrchestrationDag,
  tags: ["autodocs"],
  args: {
    data: workflowData.orchestration,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof OrchestrationDag>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
