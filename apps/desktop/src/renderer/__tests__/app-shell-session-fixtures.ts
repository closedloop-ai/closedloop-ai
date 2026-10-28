/**
 * @description Agent-session data builders and the shared list filter used by
 * the desktop shell route tests.
 *
 * Split out of the former monolithic `app-shell.test.tsx` (ISS-5037), since
 * split by responsibility into the `app-shell-*.test.tsx` siblings: its data
 * factories are a cohesive unit with no dependency on the suites' `vi.mock`
 * graph — they are plain builders. Keeping them here lets those suites hold
 * test CASES only.
 */
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import {
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  type ListQueryExpression,
  ListSortDirection,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { expect } from "vitest";

export function agentSessionListItem({
  id,
  name,
  status,
}: {
  id: string;
  name: string;
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
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: timestamp,
    status,
    toolUseCount: 1,
    updatedAt: timestamp,
    user: null,
    worktreePath: "/tmp/closedloop-ai",
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
        estimatedCostUsd: item.estimatedCost ?? undefined,
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
  listQuery?: ListQueryExpression;
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
  const statuses = requestedSessionStatuses(request);
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

/**
 * The statuses a Sessions read asks for, whichever spelling carries them: the
 * canonical `listQuery` status clause (PRD-721) or the legacy `statuses` and
 * `status` params.
 */
export function requestedSessionStatuses(request: {
  listQuery?: ListQueryExpression;
  status?: string;
  statuses?: readonly string[];
}): string[] {
  if (request.statuses && request.statuses.length > 0) {
    return [...request.statuses];
  }
  if (request.status) {
    return [request.status];
  }
  const clause = request.listQuery?.filters?.find(
    (filter) =>
      filter.field === SessionListField.Status &&
      filter.operator === ListFilterOperator.IsAnyOf
  );
  return clause && "values" in clause ? clause.values.map(String) : [];
}

/**
 * The canonical Sessions read the list sends with no facet chosen: the stable
 * last-activity window and the default most-recent-activity sort (PLN-1034),
 * with `search` riding beside the expression.
 */
export function defaultSessionsPageDataRequest({
  offset,
  search,
}: {
  offset: number;
  search: string | undefined;
}) {
  return {
    readInitiator: ReadInitiator.User,
    limit: 25,
    offset,
    search,
    listQuery: {
      version: LIST_QUERY_EXPRESSION_VERSION,
      filters: [
        {
          field: SessionListField.LastActivity,
          operator: ListFilterOperator.IsBetween,
          min: expect.any(String),
          max: expect.any(String),
        },
      ],
      sorts: [
        {
          field: SessionListField.LastActivity,
          direction: ListSortDirection.Desc,
        },
      ],
    },
  };
}
