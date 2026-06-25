import type { SessionAgent } from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import { AgentCard } from "./agent-card";

const agent: SessionAgent = {
  id: "agent-main",
  sessionId: "session-1",
  name: "Main Agent",
  type: "main",
  status: "working",
  task: "Decompose monitoring and session surfaces into shared UI primitives.",
  currentTool: "Edit",
  model: "gpt-5.5",
  cost: 1.82,
  label: "Desktop sync champion",
  startedAt: "2026-05-29T12:00:00.000Z",
  updatedAt: "2026-05-29T12:08:00.000Z",
  children: [
    {
      id: "agent-child-1",
      sessionId: "session-1",
      name: "Verification Worker",
      type: "subagent",
      subagentType: "code:verification-subagent",
      status: "waiting",
      task: "Validate Storybook coverage against the component catalog.",
      currentTool: "Read",
      model: "gpt-5.5-mini",
      startedAt: "2026-05-29T12:02:00.000Z",
      updatedAt: "2026-05-29T12:07:00.000Z",
    },
  ],
};

const meta = {
  title: "App Core/Agents/Agent Card",
  component: AgentCard,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { agent },
} satisfies Meta<typeof AgentCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };
