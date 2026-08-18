/**
 * @file app-shell-session-fixtures.ts
 * @description Agent-session data builders and the shared list filter used by
 * the desktop shell route tests.
 *
 * Split out of `app-shell.test.tsx` (ISS-5037): that file is a grandfathered
 * over-size module, and its data factories are a cohesive unit with no
 * dependency on the suite's `vi.mock` graph — they are plain builders. Keeping
 * them here lets the shell suite hold test CASES and shrinks the grandfathered
 * file rather than growing it.
 */
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionState,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";

export function agentSessionListItem({
  id,
  name,
  state,
  status,
}: {
  id: string;
  name: string;
  state?: AgentSessionState;
  status: string;
}): AgentSessionListItem {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastAgentSessionSyncAt: timestamp,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cwd: "/tmp/shell-session",
    endedAt: timestamp,
    errorCount: status === "failed" ? 1 : 0,
    estimatedCost: 0.01,
    externalSessionId: id,
    harness: "codex",
    id,
    inputTokens: 10,
    lastActivityAt: timestamp,
    lastSyncedAt: timestamp,
    model: "gpt-test",
    name,
    outputTokens: 20,
    project: null,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: timestamp,
    state,
    status,
    toolUseCount: 1,
    updatedAt: timestamp,
    user: null,
    worktreePath: "/tmp/symphony-alpha",
  };
}

export function agentSessionDetail(
  item: AgentSessionListItem
): AgentSessionDetail {
  return {
    ...item,
    agents: [
      {
        endedAt: item.endedAt?.toISOString() ?? null,
        externalAgentId: `${item.id}-agent`,
        name: "Main",
        startedAt: item.startedAt.toISOString(),
        status: "completed",
        task: "Rendered shared shell route",
        type: "main",
        updatedAt: item.updatedAt.toISOString(),
      },
    ],
    attribution: {
      baseBranch: null,
      repositoryFullName: item.repositoryFullName,
      sourceArtifactId: null,
      sourceLoopId: null,
      worktreePath: item.worktreePath,
    },
    events: [
      {
        createdAt: item.updatedAt.toISOString(),
        eventType: "agent_message",
        externalEventId: `${item.id}-event`,
        summary: "Shared detail event",
      },
    ],
    metadata: { shell: true },
    sourceArtifactId: null,
    sourceLoopId: null,
    tokenUsageByModel: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: item.estimatedCost,
        inputTokens: item.inputTokens,
        model: item.model ?? "gpt-test",
        outputTokens: item.outputTokens,
      },
    ],
  };
}

export function agentSessionUsage(
  totalSessions: number
): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0.04,
    byHarness: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.04,
        harness: "codex",
        inputTokens: 10,
        outputTokens: 20,
        sessionCount: totalSessions,
      },
    ],
    byModel: [
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0.04,
        inputTokens: 10,
        model: "gpt-test",
        outputTokens: 20,
        sessionCount: totalSessions,
      },
    ],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    latestSessionAt: null,
    lastSyncTargets: [],
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0.04,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalSessions,
    viewerScope: "self",
  };
}

export function agentSessionAnalytics(): AgentSessionAnalytics {
  return {
    byAgentType: [],
    byProject: [],
    byRepository: [],
    byTool: [],
    viewerScope: "self",
  };
}

export type ShellSessionsListRequest = {
  limit?: number;
  offset?: number;
  search?: string;
  status?: string;
  statuses?: string[];
};

// Shared status/search/pagination filter the `list` and `pageData` mocks both
// serve, so the two reads stay in lockstep regardless of which one a surface
// under test invokes (FEA-4157 combined the Sessions list + summary read).
export function filterSessionsList(
  items: AgentSessionListItem[],
  request: ShellSessionsListRequest
): AgentSessionListResponse {
  let statuses: string[] = [];
  if (request.statuses && request.statuses.length > 0) {
    statuses = request.statuses;
  } else if (request.status) {
    statuses = [request.status];
  }
  let filtered =
    statuses.length > 0
      ? items.filter((item) => statuses.includes(item.status))
      : items;
  if (request.search) {
    const normalizedSearch = request.search.toLowerCase();
    filtered = filtered.filter((item) =>
      [
        item.name,
        item.externalSessionId,
        item.harness,
        item.cwd,
        item.repositoryFullName,
        item.baseBranch,
      ].some((value) => value?.toLowerCase().includes(normalizedSearch))
    );
  }
  const offset = request.offset ?? 0;
  const limit = request.limit ?? filtered.length;
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    viewerScope: "self",
  };
}
