import type {
  EventFilterSelection,
  SessionAgent,
  SessionEventFacets,
  SessionEventGroup,
  SessionOverviewStats,
} from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import {
  JsonPanel,
  SessionAgentsSection,
  SessionErrorDetailsPanel,
  SessionMetadataPanel,
  SessionModelUsageTable,
  SessionOverviewSection,
  SessionSummaryMetrics,
  SessionTimelineSection,
  SessionToolInvocationsPanel,
} from "./session-detail-panels";

const summaryMetrics = [
  { label: "Events", value: "1,284", detail: "5/min" },
  { label: "Tool calls", value: "424", detail: "86 write calls" },
  { label: "Subagents", value: "9", detail: "4 active reviewers" },
  { label: "Errors", value: "2", detail: "Both recovered" },
];

const metadata = [
  { label: "Session", value: "Storybook coverage backfill" },
  { label: "Repository", value: "closedloop-ai/symphony-alpha" },
  { label: "Harness", value: "codex" },
  { label: "Model", value: "gpt-5" },
];

const details = [
  { label: "Working directory", value: "/workspace/symphony-alpha" },
  { label: "Branch", value: "bot/nightly-storyteller-steve-2026-06-13" },
];

const modelRows = [
  {
    model: "gpt-5",
    inputTokens: "42.6M",
    outputTokens: "255.9K",
    cacheReadTokens: "40.2M",
    cacheWriteTokens: "0",
    estimatedCost: "$18.94",
  },
  {
    model: "claude-sonnet-4.6",
    inputTokens: "6.8M",
    outputTokens: "84.1K",
    cacheReadTokens: "5.9M",
    cacheWriteTokens: "120K",
    estimatedCost: "$4.11",
  },
];

const toolRows = [
  {
    toolName: "exec_command",
    count: "424",
    firstSeenAt: "09:11",
    lastSeenAt: "15:21",
  },
  {
    toolName: "apply_patch",
    count: "47",
    firstSeenAt: "10:03",
    lastSeenAt: "15:04",
  },
];

const errors = [
  {
    id: "err-1",
    eventType: "ToolError",
    createdAt: "14:52",
    summary: "Story catalog validation failed on a missing composite category.",
    rawData: JSON.stringify({ component: "agent-collaboration-network" }),
  },
];

const agents: SessionAgent[] = [
  {
    id: "agent-main",
    sessionId: "sess-1",
    name: "Main agent",
    type: "main",
    status: "working",
    task: "Convert nightly findings into implementation PRs.",
    currentTool: "apply_patch",
    startedAt: "2026-06-13T09:10:00.000Z",
    updatedAt: "2026-06-13T15:21:00.000Z",
    model: "gpt-5",
    label: "gpt-5",
  },
  {
    id: "agent-review",
    sessionId: "sess-1",
    name: "reviewer",
    type: "subagent",
    subagentType: "reviewer",
    status: "completed",
    task: "Review coverage gaps before Storybook validation.",
    currentTool: null,
    startedAt: "2026-06-13T09:34:00.000Z",
    endedAt: "2026-06-13T10:02:00.000Z",
    label: "reviewer",
  },
];

const facets: SessionEventFacets = {
  statuses: ["working", "completed", "error"],
  eventTypes: ["PreToolUse", "PostToolUse", "ToolError"],
  toolNames: ["Read", "apply_patch", "pnpm"],
  agents: [
    { id: "agent-main", label: "Main agent" },
    { id: "agent-review", label: "reviewer" },
  ],
};

const activeFilters: EventFilterSelection = {
  query: "storybook",
  statuses: ["working"],
  eventTypes: ["PreToolUse"],
  toolNames: ["Read"],
  agents: [{ id: "agent-main", label: "Main agent" }],
};

const groups: SessionEventGroup[] = [
  {
    id: "group-1",
    title: "Coverage inventory",
    durationLabel: "6m",
    events: [
      {
        id: "event-1",
        sessionId: "sess-1",
        agentId: "agent-main",
        agentLabel: "Main agent",
        eventType: "PreToolUse",
        status: "working",
        title: "Read missing component stories",
        summary:
          "The run identified eight design-system components without stories.",
        toolName: "Read",
        project: "symphony-alpha",
        createdAt: "2026-06-13T09:11:00.000Z",
        metadata: [{ label: "components", value: "8" }],
      },
    ],
  },
];

const overviewStats: SessionOverviewStats = {
  totalEvents: 1284,
  toolCalls: 424,
  subagents: 9,
  compactions: 3,
  errors: 2,
  durationLabel: "4h 18m",
  eventRateHint: "5/min",
  topTools: [
    { toolName: "exec_command", count: 424 },
    { toolName: "apply_patch", count: 47 },
  ],
  subagentTypes: [
    { label: "reviewer", count: 4 },
    { label: "Context Compaction", count: 3, isCompaction: true },
  ],
  tokens: {
    cacheReadTokens: 40_200_000,
    cacheWriteTokens: 0,
    inputTokens: 42_600_000,
    outputTokens: 255_900,
  },
  eventMix: [{ eventType: "tool_use", count: 612 }],
  activeAgent: {
    name: "Main agent",
    currentTool: "apply_patch",
    task: "Adding missing Storybook stories and catalog references.",
  },
};

function SessionDetailPanelsOverview() {
  return (
    <div className="space-y-6">
      <SessionSummaryMetrics metrics={summaryMetrics} />
      <SessionMetadataPanel details={details} metadata={metadata} />
      <SessionOverviewSection stats={overviewStats} />
    </div>
  );
}

function SessionDetailPanelsTables() {
  return (
    <div className="space-y-6">
      <SessionModelUsageTable rows={modelRows} />
      <SessionToolInvocationsPanel rows={toolRows} />
      <SessionErrorDetailsPanel errors={errors} />
    </div>
  );
}

function SessionDetailPanelsActivity() {
  return (
    <div className="space-y-6">
      <SessionAgentsSection activeAgentId="agent-main" agents={agents} />
      <SessionTimelineSection
        activeFilters={activeFilters}
        facets={facets}
        groups={groups}
      />
      <JsonPanel
        description="Raw attribution captured by the desktop monitor."
        title="Attribution"
        value={JSON.stringify({ source: "desktop", confidence: 0.98 }, null, 2)}
      />
    </div>
  );
}

const meta = {
  title: "App Core/Agents/Session Detail Panels",
  component: SessionDetailPanelsOverview,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionDetailPanelsOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};

export const Tables: Story = {
  render: () => <SessionDetailPanelsTables />,
};

export const Activity: Story = {
  render: () => <SessionDetailPanelsActivity />,
};

export const EmptyStates: Story = {
  render: () => (
    <div className="space-y-6">
      <SessionModelUsageTable rows={[]} />
      <SessionToolInvocationsPanel rows={[]} />
      <SessionErrorDetailsPanel errors={[]} />
      <SessionAgentsSection agents={[]} />
      <SessionTimelineSection facets={facets} groups={[]} />
      <JsonPanel title="Attribution" value={null} />
    </div>
  ),
};
