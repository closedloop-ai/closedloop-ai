import {
  type AgentSessionDetail,
  AgentSessionState,
} from "@repo/api/src/types/agent-session";

/**
 * The shared desktop session-detail fixture. Extracted from
 * `session-detail-view.test.tsx` (ISS-5567) once a second suite needed the same
 * ~90-line record — one source of truth so the two cannot drift into asserting
 * against different sessions.
 */
export function sessionDetail({
  id,
  name,
  overrides = {},
  state,
  status,
}: {
  id: string;
  name: string;
  overrides?: Partial<AgentSessionDetail>;
  state: AgentSessionState;
  status: string;
}): AgentSessionDetail {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    activeAgent: "8m",
    agentCount: 1,
    agents: [],
    attribution: {
      baseBranch: "main",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      sourceArtifactId: "FEA-1943",
      sourceLoopId: null,
      worktreePath: "/tmp/symphony-alpha",
    },
    awaitingInputSince:
      state === AgentSessionState.PendingApproval ? timestamp : null,
    autonomy: 82,
    baseBranch: "main",
    branch: "feat/fea-1943-session-details-local-data",
    cache: 3,
    cacheReadTokens: 0,
    cacheWrite: 4,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastAgentSessionSyncAt: timestamp,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cost: "$0.01",
    cwd: "/tmp/symphony-alpha",
    endedAt: null,
    errorCount: state === AgentSessionState.Blocked ? 1 : 0,
    estimatedCost: 0.01,
    events: [],
    externalSessionId: id,
    filesChanged: 1,
    harness: "codex",
    id,
    inputTokens: 10,
    lastActivityAt: timestamp,
    lastSyncedAt: timestamp,
    linesAdded: 12,
    linesRemoved: 2,
    metadata: null,
    model: "gpt-test",
    models: ["gpt-test"],
    name,
    outputTokens: 20,
    primaryModel: "gpt-test",
    project: null,
    prs: [{ num: 1686, status: "merged", title: "Complete local details" }],
    prsMerged: 1,
    repo: "closedloop-ai/symphony-alpha",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: "FEA-1943",
    sourceLoopId: null,
    steeringEpisodes: 1,
    startedAt: timestamp,
    state,
    status,
    timeline: [],
    tokenUsageByModel: [],
    tokensIn: 10,
    tokensOut: 20,
    toolCallsTotal: 7,
    toolUseCount: 7,
    turnItems: [],
    turns: 3,
    updatedAt: timestamp,
    user: null,
    userColor: null,
    wallClock: "10m",
    waitingUser: state === AgentSessionState.PendingApproval ? "2m" : null,
    worktreePath: "/tmp/symphony-alpha",
    ...overrides,
  };
}
