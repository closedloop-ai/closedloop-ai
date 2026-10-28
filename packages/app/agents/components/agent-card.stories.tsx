import type { SessionAgent } from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import { LabelledStates } from "../../shared/storybook/story-states";
import { AgentCard } from "./agent-card";

const agent: SessionAgent = {
  id: "agent-main",
  sessionId: "session-1",
  name: "Main Agent",
  type: "main",
  status: "working",
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
      currentTool: "Read",
      model: "gpt-5.5-mini",
      startedAt: "2026-05-29T12:02:00.000Z",
      updatedAt: "2026-05-29T12:07:00.000Z",
    },
  ],
};

const workingMainAgent: SessionAgent = {
  id: "agent-working-main",
  sessionId: "session-1",
  name: "Session orchestrator",
  type: "main",
  status: "working",
  currentTool: "Edit",
  model: "gpt-5.5",
  startedAt: "2026-05-29T12:00:00.000Z",
  updatedAt: "2026-05-29T12:08:00.000Z",
};

const waitingSubagent: SessionAgent = {
  id: "agent-waiting-sub",
  sessionId: "session-1",
  name: "Verification Worker",
  type: "subagent",
  subagentType: "code:verification-subagent",
  status: "waiting",
  currentTool: "Read",
  model: "gpt-5.5-mini",
  startedAt: "2026-05-29T12:02:00.000Z",
  updatedAt: "2026-05-29T12:07:00.000Z",
};

const idleSubagent: SessionAgent = {
  id: "agent-idle-sub",
  sessionId: "session-1",
  name: "Review lane",
  type: "subagent",
  subagentType: "reviewer",
  status: "idle",
  model: "gpt-5.5-mini",
  startedAt: "2026-05-29T11:50:00.000Z",
  updatedAt: "2026-05-29T12:05:00.000Z",
};

/**
 * Every combination of the left-border status treatment (`statusBorderClass`)
 * and the type icon (`Bot` for main, `GitBranch` for subagent), side by side.
 * {@link Default} and {@link Active} only ever show `working` on a `main` card;
 * this is where `waiting` (amber border) and a plain `subagent` card with
 * neither border color actually render.
 */
function AgentCardStatusPalette() {
  return (
    <LabelledStates
      rows={[
        ["Working, main", <AgentCard agent={workingMainAgent} key="working" />],
        [
          "Waiting, subagent",
          <AgentCard agent={waitingSubagent} key="waiting" />,
        ],
        ["Idle, subagent", <AgentCard agent={idleSubagent} key="idle" />],
      ]}
    />
  );
}

const meta = {
  title: "Composites v1.0/Agents/General/Agent Card",
  component: AgentCard,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
  args: { agent },
} satisfies Meta<typeof AgentCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Active: Story = { args: { active: true } };
export const StatusPalette: Story = {
  render: () => <AgentCardStatusPalette />,
};
