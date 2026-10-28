import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { LEGACY_WAITING_WIRE_STATUS } from "@repo/api/src/types/session-status";

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
  status,
}: {
  id: string;
  name: string;
  overrides?: Partial<AgentSessionDetail>;
  status: string;
}): AgentSessionDetail {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  /*
   * ISS-7019: a LIVE activity anchor, read per call rather than at module
   * load so it cannot go stale between import and render.
   *
   * `startedAt` stays pinned — the suites override timeline events at fixed
   * instants relative to it, and duration is measured from it. But the detail
   * Status row reads the displayed status now that the second axis is gone,
   * and the displayed fold judges liveness on the ACTIVITY anchor. Against the
   * old fixed one this session was silent for months, so a fixture the suites
   * describe as RUNNING folded to `stale` and its Duration cell rendered "—".
   * It only ever read as running because the deleted axis ignored the clock.
   */
  const activityAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return {
    activeAgent: "8m",
    agentCount: 1,
    agents: [],
    attribution: {
      baseBranch: "main",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      sourceArtifactId: "FEA-1943",
      sourceLoopId: null,
      worktreePath: "/tmp/closedloop-ai",
    },
    awaitingInputSince:
      status === LEGACY_WAITING_WIRE_STATUS ? timestamp : null,
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
    cwd: "/tmp/closedloop-ai",
    endedAt: null,
    errorCount: status === "active" ? 1 : 0,
    estimatedCost: 0.01,
    events: [],
    externalSessionId: id,
    filesChanged: 1,
    harness: "codex",
    id,
    inputTokens: 10,
    lastActivityAt: activityAt,
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
    repo: "closedloop-ai/closedloop-ai",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: "FEA-1943",
    sourceLoopId: null,
    steeringEpisodes: 1,
    startedAt: timestamp,
    status,
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
    waitingUser: status === LEGACY_WAITING_WIRE_STATUS ? "2m" : null,
    worktreePath: "/tmp/closedloop-ai",
    ...overrides,
  };
}
