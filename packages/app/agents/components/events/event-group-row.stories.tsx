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

/**
 * A collapsible row for one step in a session's activity log: its title,
 * which tool ran, when it happened, and a status badge, with a chevron to
 * expand and see every event inside that step in full detail. Use it to list
 * a session's timeline instead of showing every raw event flat, since
 * related events, like a tool call and its result, are grouped under one row
 * rather than shown as two disconnected lines. A row that groups more than
 * one event gets a colored left border and an event count, so a multi-event
 * group is visually distinct from a single simple action before you even
 * expand it.
 */
const meta = {
  title: "Composites/Sessions/Detail/Event Group Row",
  component: EventGroupRow,
  tags: ["autodocs"],
  argTypes: {
    group: {
      control: "object",
      description:
        "The coalesced event group. More than one event switches the row to its multi-event treatment.",
    },
    defaultExpanded: {
      control: "boolean",
      description:
        "Initial disclosure state only; the row owns it after mount.",
    },
  },
  parameters: { layout: "padded" },
  args: { group, defaultExpanded: true },
} satisfies Meta<typeof EventGroupRow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
