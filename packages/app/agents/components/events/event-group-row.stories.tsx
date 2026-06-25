import type { SessionEventGroup } from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import { EventGroupRow } from "./event-group-row";

const group: SessionEventGroup = {
  id: "group-1",
  title: "Edit session table",
  durationLabel: "14s",
  events: [
    {
      id: "event-1",
      sessionId: "sess-1",
      agentId: "agent-1",
      agentLabel: "Main agent",
      project: "symphony-alpha",
      eventType: "tool_use",
      status: "working",
      toolName: "Edit",
      title: "Editing shared table",
      summary: "Updated the shared session table composition.",
      createdAt: "2026-05-29T12:00:00.000Z",
      metadata: [{ label: "file", value: "session-table.tsx" }],
    },
    {
      id: "event-2",
      sessionId: "sess-1",
      agentId: "agent-1",
      agentLabel: "Main agent",
      project: "symphony-alpha",
      eventType: "tool_result",
      status: "completed",
      toolName: "Edit",
      title: "Patch applied",
      summary:
        "Shared session table now renders cost, agents, and last activity.",
      createdAt: "2026-05-29T12:00:14.000Z",
    },
  ],
};

const meta = {
  title: "App Core/Agents/Event Group Row",
  component: EventGroupRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { group, defaultExpanded: true },
} satisfies Meta<typeof EventGroupRow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
