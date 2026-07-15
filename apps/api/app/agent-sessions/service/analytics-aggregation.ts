import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  AGENT_FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import type {
  AgentSessionAgentTypeBreakdown,
  AgentSessionProjectBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
  SyncedAgentSessionAgent,
} from "@repo/api/src/types/agent-session";
import { withDb } from "@repo/database";
import { decimalToNumber, tokenCountToNumber } from "./coercion";
import type {
  AnalyticsJsonSessionRecord,
  AnalyticsScalarSessionRecord,
} from "./records";
import { toSyncedAgents, toSyncedEvents } from "./synced-payload";

export function aggregateFullArtifactSessionUsageByModel(input: {
  organizationId: string;
  sessionArtifactIds: string[];
}) {
  return withDb((db) =>
    Promise.all([
      db.sessionDetail.aggregate({
        where: {
          artifactId: { in: input.sessionArtifactIds },
          artifact: { organizationId: input.organizationId },
        },
        _count: { _all: true },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
        },
      }),
      db.agentSessionTokenUsage.groupBy({
        by: ["model"],
        where: {
          agentSessionId: { in: input.sessionArtifactIds },
          session: { artifact: { organizationId: input.organizationId } },
        },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
        },
      }),
    ])
  );
}

export function aggregateByTool(
  sessions: AnalyticsJsonSessionRecord[]
): AgentSessionToolBreakdown[] {
  const map = new Map<
    string,
    { invocationCount: number; errorCount: number; sessionIds: Set<string> }
  >();

  for (const session of sessions) {
    const events = toSyncedEvents(session.events);
    for (const event of events) {
      if (!event.toolName) {
        continue;
      }
      const existing = map.get(event.toolName);
      const isError = ERROR_EVENT_PATTERN.test(event.eventType);
      if (existing) {
        existing.invocationCount += 1;
        if (isError) {
          existing.errorCount += 1;
        }
        existing.sessionIds.add(session.artifactId);
      } else {
        map.set(event.toolName, {
          invocationCount: 1,
          errorCount: isError ? 1 : 0,
          sessionIds: new Set([session.artifactId]),
        });
      }
    }
  }

  return [...map.entries()]
    .map(([toolName, data]) => ({
      toolName,
      invocationCount: data.invocationCount,
      errorCount: data.errorCount,
      sessionCount: data.sessionIds.size,
    }))
    .sort((left, right) => right.invocationCount - left.invocationCount);
}

type AgentTypeAccumulator = {
  count: number;
  successCount: number;
  failedCount: number;
  durations: number[];
};

function accumulateAgentType(
  map: Map<string, AgentTypeAccumulator>,
  agent: SyncedAgentSessionAgent
): void {
  const key = agent.subagentType ?? agent.type ?? "unknown";
  const isSuccess = AGENT_SUCCESS_STATUS_PATTERN.test(agent.status);
  const isFailed = AGENT_FAILED_STATUS_PATTERN.test(agent.status);
  const duration = computeAgentDuration(agent.startedAt, agent.endedAt);

  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.successCount += isSuccess ? 1 : 0;
    existing.failedCount += isFailed ? 1 : 0;
    if (duration !== null) {
      existing.durations.push(duration);
    }
  } else {
    map.set(key, {
      count: 1,
      successCount: isSuccess ? 1 : 0,
      failedCount: isFailed ? 1 : 0,
      durations: duration === null ? [] : [duration],
    });
  }
}

export function aggregateByAgentType(
  sessions: AnalyticsJsonSessionRecord[]
): AgentSessionAgentTypeBreakdown[] {
  const map = new Map<string, AgentTypeAccumulator>();

  for (const session of sessions) {
    const agents = toSyncedAgents(session.agents);
    for (const agent of agents) {
      accumulateAgentType(map, agent);
    }
  }

  return [...map.entries()]
    .map(([agentType, data]) => ({
      agentType,
      count: data.count,
      successCount: data.successCount,
      failedCount: data.failedCount,
      avgDurationMs:
        data.durations.length > 0
          ? Math.round(
              data.durations.reduce((sum, d) => sum + d, 0) /
                data.durations.length
            )
          : null,
    }))
    .sort((left, right) => right.count - left.count);
}

export function aggregateByRepository(
  sessions: AnalyticsScalarSessionRecord[]
): AgentSessionRepositoryBreakdown[] {
  const map = new Map<
    string,
    {
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
      errorCount: number;
    }
  >();

  for (const session of sessions) {
    const repo = session.repositoryFullName;
    if (!repo) {
      continue;
    }
    const existing = map.get(repo);
    const cost = decimalToNumber(session.estimatedCost);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += tokenCountToNumber(session.inputTokens);
      existing.outputTokens += tokenCountToNumber(session.outputTokens);
      existing.estimatedCost += cost;
      existing.errorCount += session.errorCount;
    } else {
      map.set(repo, {
        sessionCount: 1,
        inputTokens: tokenCountToNumber(session.inputTokens),
        outputTokens: tokenCountToNumber(session.outputTokens),
        estimatedCost: cost,
        errorCount: session.errorCount,
      });
    }
  }

  return [...map.entries()]
    .map(([repositoryFullName, data]) => ({
      repositoryFullName,
      ...data,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

export function aggregateByProject(
  sessions: AnalyticsScalarSessionRecord[]
): AgentSessionProjectBreakdown[] {
  const map = new Map<
    string,
    {
      projectName: string;
      projectSlug: string | null;
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    }
  >();

  for (const session of sessions) {
    const project = session.artifact.project;
    if (!(session.artifact.projectId && project)) {
      continue;
    }
    const existing = map.get(session.artifact.projectId);
    const cost = decimalToNumber(session.estimatedCost);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += tokenCountToNumber(session.inputTokens);
      existing.outputTokens += tokenCountToNumber(session.outputTokens);
      existing.estimatedCost += cost;
    } else {
      map.set(session.artifact.projectId, {
        projectName: project.name,
        projectSlug: project.slug,
        sessionCount: 1,
        inputTokens: tokenCountToNumber(session.inputTokens),
        outputTokens: tokenCountToNumber(session.outputTokens),
        estimatedCost: cost,
      });
    }
  }

  return [...map.entries()]
    .map(([projectId, data]) => ({
      projectId,
      ...data,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

function computeAgentDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const duration = end - start;
  return duration >= 0 ? duration : null;
}
