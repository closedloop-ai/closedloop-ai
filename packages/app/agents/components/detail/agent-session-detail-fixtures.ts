import {
  type AgentSessionDetail,
  AgentSessionOrigin,
  AgentSessionState,
} from "@repo/api/src/types/agent-session";

const BASE_TIME = "2026-06-10T12:00:00.000Z";

export function createAgentSessionDetailFixture(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  const agentActor = {
    name: "gpt-5.5",
    sessionId: "session-detail-1",
    human: null,
    color: "var(--primary)",
    harness: "codex",
  };
  const humanActor = {
    name: null,
    sessionId: "session-detail-1",
    human: "Ada Lovelace",
    color: "hsl(210 65% 45%)",
  };
  const session: AgentSessionDetail = {
    id: "session-detail-1",
    slug: "SES-1",
    externalSessionId: "ext-session-1",
    name: "Desktop implementation session",
    status: "completed",
    origin: AgentSessionOrigin.DesktopSync,
    state: AgentSessionState.Completed,
    harness: "codex",
    cwd: "repos/symphony-alpha",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repo: "closedloop-ai/symphony-alpha",
    worktreePath: "worktrees/symphony-alpha-fea-1707",
    model: "gpt-5.5",
    primaryModel: "gpt-5.5",
    models: ["gpt-5.5"],
    branch: "fea-1707",
    prs: [],
    prsMerged: 0,
    cost: "$4.82",
    wallClock: "20m",
    activeAgent: "18m",
    waitingUser: null,
    linesAdded: 120,
    linesRemoved: 12,
    filesChanged: 4,
    turns: 8,
    toolCallsTotal: 5,
    steeringEpisodes: 1,
    autonomy: 82,
    tokensIn: 12_000,
    tokensOut: 3200,
    cache: 900,
    cacheWrite: 400,
    userColor: "hsl(210 65% 45%)",
    activityBuckets: [],
    span: null,
    markers: [],
    throttles: [],
    phases: [],
    phaseIterations: {},
    phaseLoopbacks: [],
    startedAt: new Date(BASE_TIME),
    updatedAt: new Date("2026-06-10T12:18:00.000Z"),
    lastActivityAt: new Date("2026-06-10T12:18:00.000Z"),
    endedAt: new Date("2026-06-10T12:20:00.000Z"),
    awaitingInputSince: null,
    inputTokens: 12_000,
    outputTokens: 3200,
    cacheReadTokens: 900,
    cacheWriteTokens: 400,
    estimatedCost: 4.82,
    agentCount: 3,
    toolUseCount: 5,
    errorCount: 1,
    baseBranch: "main",
    sourceArtifactId: "FEA-1707",
    sourceArtifact: {
      id: "artifact-1",
      name: "Shared Agent Sessions Detail Foundation",
      slug: "FEA-1707",
      documentType: null,
    },
    sourceLoopId: "loop-1",
    user: {
      id: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    },
    computeTarget: {
      id: "target-1",
      machineName: "Ada's MacBook",
      isOnline: true,
      lastSeenAt: new Date("2026-06-10T12:21:00.000Z"),
    },
    project: {
      id: "project-1",
      name: "Desktop MLP",
      slug: "PRO-1",
    },
    metadata: {
      branch: "fea-1707",
      validation: "rendered-screen",
    },
    tokenUsageByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 12_000,
        outputTokens: 3200,
        cacheReadTokens: 900,
        cacheWriteTokens: 400,
        estimatedCostUsd: 4.82,
      },
    ],
    attribution: {
      repositoryFullName: "closedloop-ai/symphony-alpha",
      worktreePath: "worktrees/symphony-alpha-fea-1707",
      sourceArtifactId: "FEA-1707",
      sourceLoopId: "loop-1",
      baseBranch: "main",
    },
    agents: [
      {
        externalAgentId: "agent-main",
        name: "Implementation worker",
        type: "main",
        status: "completed",
        task: "Extract the shared detail foundation.",
        currentTool: null,
        startedAt: BASE_TIME,
        updatedAt: "2026-06-10T12:18:00.000Z",
        endedAt: "2026-06-10T12:20:00.000Z",
        parentExternalAgentId: null,
      },
      {
        externalAgentId: "agent-review",
        name: "Review lane",
        type: "subagent",
        subagentType: "review",
        status: "failed",
        task: "Verify import ownership and state coverage.",
        currentTool: null,
        startedAt: "2026-06-10T12:04:00.000Z",
        updatedAt: "2026-06-10T12:12:00.000Z",
        endedAt: "2026-06-10T12:12:00.000Z",
        parentExternalAgentId: "agent-main",
      },
      {
        externalAgentId: "agent-ui",
        name: "Rendered UI checker",
        type: "subagent",
        subagentType: "visual",
        status: "completed",
        task: "Capture Storybook screenshots.",
        currentTool: "playwright",
        startedAt: "2026-06-10T12:08:00.000Z",
        updatedAt: "2026-06-10T12:17:00.000Z",
        endedAt: "2026-06-10T12:17:00.000Z",
        parentExternalAgentId: "agent-main",
      },
    ],
    events: [
      {
        externalEventId: "event-1",
        agentExternalId: "agent-main",
        eventType: "session_started",
        summary: "Implementation started.",
        createdAt: BASE_TIME,
      },
      {
        externalEventId: "event-2",
        agentExternalId: "agent-main",
        eventType: "tool_use",
        toolName: "rg",
        summary: "Inspected current detail callers.",
        data: { pattern: "AgentSessionDetailView" },
        createdAt: "2026-06-10T12:02:00.000Z",
      },
      {
        externalEventId: "event-3",
        agentExternalId: "agent-review",
        eventType: "error",
        toolName: "vitest",
        summary: "Review lane found an import ownership issue.",
        data: { file: "packages/app/agents/components/detail/example.tsx" },
        createdAt: "2026-06-10T12:12:00.000Z",
      },
      {
        externalEventId: "event-4",
        agentExternalId: "agent-ui",
        eventType: "tool_use",
        toolName: "playwright",
        summary: "Captured desktop and mobile screenshots.",
        createdAt: "2026-06-10T12:17:00.000Z",
      },
    ],
    timeline: [
      {
        t: "2026-06-10T12:02:00.000Z",
        tMs: Date.parse("2026-06-10T12:02:00.000Z"),
        kind: "tool",
        title: "rg",
        tl: 0,
      },
      {
        t: "2026-06-10T12:12:00.000Z",
        tMs: Date.parse("2026-06-10T12:12:00.000Z"),
        kind: "tool",
        title: "vitest",
        err: true,
        tl: 1,
      },
    ],
    turnItems: [
      {
        type: "prompt",
        _row: 0,
        t: "2026-06-10T12:01:00.000Z",
        tMs: Date.parse("2026-06-10T12:01:00.000Z"),
        cum: 0,
        actor: humanActor,
        text: "Please inspect the shared session detail screen.",
      },
      {
        type: "say",
        _row: 1,
        t: "2026-06-10T12:01:20.000Z",
        tMs: Date.parse("2026-06-10T12:01:20.000Z"),
        cum: 0.003,
        costDelta: 0.003,
        actor: agentActor,
        isThinking: true,
        model: "gpt-5.5",
        text: "The dashboard mixes metrics and transcript; a dedicated trace view reads better.",
      },
      {
        type: "say",
        _row: 2,
        t: "2026-06-10T12:01:30.000Z",
        tMs: Date.parse("2026-06-10T12:01:30.000Z"),
        cum: 0.063,
        costDelta: 0.06,
        actor: agentActor,
        model: "gpt-5.5",
        text: "I will replace the details dashboard with a Session Trace workspace.",
      },
      {
        type: "tools",
        _row: 3,
        t: "2026-06-10T12:02:00.000Z",
        tMs: Date.parse("2026-06-10T12:02:00.000Z"),
        endMs: Date.parse("2026-06-10T12:03:00.000Z"),
        cum: 1.293,
        costDelta: 1.23,
        actor: agentActor,
        summary: "Ran 2 tools",
        items: [
          { label: "rg", detail: "AgentSessionDetailView", err: false },
          { label: "vitest", detail: "detail view coverage", err: true },
        ],
        hasFail: true,
        failN: 1,
        defaultOpen: true,
        cats: { tool: 2 },
      },
      {
        type: "event",
        _row: 4,
        t: "2026-06-10T12:03:30.000Z",
        tMs: Date.parse("2026-06-10T12:03:30.000Z"),
        dot: "g",
        text: "Initial implementation checkpoint after #3.",
        tag: "checkpoint",
      },
      {
        type: "subagent",
        _row: 5,
        t: "2026-06-10T12:04:00.000Z",
        tMs: Date.parse("2026-06-10T12:04:00.000Z"),
        cum: 2.403,
        costDelta: 1.11,
        actor: agentActor,
        sub: "Review lane",
        subagentType: "review",
        status: "failed",
        model: "gpt-5.5",
        duration: "8m",
        tokens: null,
        cost: null,
        body: [
          {
            kind: "task",
            text: "Verify import ownership and state coverage.",
          },
          {
            kind: "tool",
            text: "vitest",
            t: "2026-06-10T12:12:00.000Z",
            err: true,
          },
          {
            kind: "status",
            text: "failed",
            t: "2026-06-10T12:12:00.000Z",
            err: true,
          },
        ],
      },
      {
        type: "end",
        text: "Session completed.",
      },
    ],
    ...overrides,
  };

  return {
    ...session,
    agentCount: overrides.agents?.length ?? session.agents.length,
    toolUseCount:
      overrides.events?.filter((event) => event.toolName).length ??
      session.toolUseCount,
    errorCount:
      overrides.events?.filter((event) =>
        event.eventType.toLowerCase().includes("error")
      ).length ?? session.errorCount,
  };
}

export const populatedAgentSessionDetailFixture =
  createAgentSessionDetailFixture();

export const emptyAgentsAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Empty agent session",
    agents: [],
    events: [],
    timeline: [],
    turnItems: [],
  });

export const noErrorAgentSessionDetailFixture = createAgentSessionDetailFixture(
  {
    name: "No-error session",
    agents: populatedAgentSessionDetailFixture.agents.map((agent) => ({
      ...agent,
      status: "completed",
    })),
    events: populatedAgentSessionDetailFixture.events.filter(
      (event) => !event.eventType.toLowerCase().includes("error")
    ),
  }
);

export const errorChainAgentSessionDetailFixture =
  createAgentSessionDetailFixture();

export const nullDateAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Null date session",
    endedAt: null,
    agents: populatedAgentSessionDetailFixture.agents.map((agent) => ({
      ...agent,
      startedAt: agent.externalAgentId === "agent-review" ? "not-a-date" : null,
      endedAt: null,
    })),
  });

export const longContentAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "A very long shared agent session detail title that must wrap cleanly without overlapping adjacent controls",
    worktreePath:
      "worktrees/symphony-alpha-fea-1707/packages/app/agents/components/detail/with/a/very/long/path/that/should/not/clip",
    events: populatedAgentSessionDetailFixture.events.map((event) => ({
      ...event,
      summary:
        "This event summary is intentionally long to verify wrapping and scrolling behavior in the timeline and tooltip surfaces without clipped readable content.",
    })),
  });
