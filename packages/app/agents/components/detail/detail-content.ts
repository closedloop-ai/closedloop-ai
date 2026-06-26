import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type {
  AgentStatus,
  EventFilterSelection,
  SessionEvent,
  SessionEventFacets,
  SessionEventGroup,
  SessionOverviewStats,
} from "@repo/app/agents/lib/session-types";
import {
  ensureDate,
  formatDate,
  formatDateTime,
} from "@repo/app/shared/lib/date-utils";
import {
  formatCost,
  formatDuration,
  formatNumber,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import { buildSessionAgents } from "./agent-tree-utils";

export type AgentSessionDetailContent = ReturnType<
  typeof buildSessionDetailContent
>;

export function buildSessionDetailContent(session: AgentSessionDetail) {
  const toolInvocations = buildToolInvocations(session.events);
  const errorEvents = session.events.filter((event) =>
    event.eventType.toLowerCase().includes("error")
  );
  const agentNames = new Map(
    session.agents.map((agent) => [agent.externalAgentId, agent.name])
  );

  const overview = buildOverviewStats(session, toolInvocations);
  const sessionAgents = buildSessionAgents(session.agents, session.events);
  const eventData = buildEventData(session, agentNames);

  return {
    metrics: [
      {
        label: "Duration",
        value: formatDuration(session.startedAt, session.endedAt),
        detail: "Start to end time",
      },
      {
        label: "Tokens",
        value: formatTokenCount(
          session.inputTokens +
            session.outputTokens +
            session.cacheReadTokens +
            session.cacheWriteTokens
        ),
        detail: "Input + output + cache",
      },
      {
        label: "Cost",
        value: formatCost(session.estimatedCost),
        detail: `${formatNumber(session.toolUseCount)} tool uses`,
      },
      {
        label: "Errors",
        value: formatNumber(session.errorCount),
        detail: `${formatNumber(session.agentCount)} agents`,
      },
    ],
    metadata: [
      { label: "Session ID", value: session.externalSessionId },
      { label: "Repository", value: session.repositoryFullName ?? "Unknown" },
      {
        label: "Compute Target",
        value: session.computeTarget.machineName,
      },
      { label: "Started", value: safeFormatDateTime(session.startedAt) },
      {
        label: "Ended",
        value: session.endedAt
          ? safeFormatDateTime(session.endedAt)
          : "Still running",
      },
      {
        label: "User",
        value: session.user
          ? [session.user.firstName, session.user.lastName]
              .filter(Boolean)
              .join(" ") || session.user.email
          : "Unattributed",
      },
    ],
    details: [
      { label: "Worktree", value: session.worktreePath ?? "Unknown" },
      { label: "CWD", value: session.cwd ?? "Unknown" },
      { label: "Base branch", value: session.baseBranch ?? "Unknown" },
      {
        label: "Source artifact",
        value: session.sourceArtifactId ?? "None",
      },
      { label: "Source loop", value: session.sourceLoopId ?? "None" },
    ],
    attribution: session.attribution ? renderJson(session.attribution) : null,
    overview,
    modelUsage: session.tokenUsageByModel.map((usage) => ({
      model: usage.model,
      inputTokens: formatTokenCount(usage.inputTokens),
      outputTokens: formatTokenCount(usage.outputTokens),
      cacheReadTokens: formatTokenCount(usage.cacheReadTokens),
      cacheWriteTokens: formatTokenCount(usage.cacheWriteTokens),
      estimatedCost: formatCost(usage.estimatedCostUsd ?? 0),
    })),
    toolInvocations: toolInvocations.map((tool) => ({
      toolName: tool.toolName,
      count: formatNumber(tool.count),
      firstSeenAt: safeFormatDateTime(tool.firstSeenAt),
      lastSeenAt: safeFormatDateTime(tool.lastSeenAt),
    })),
    errors: errorEvents.map((event) => ({
      id: event.externalEventId,
      eventType: event.eventType,
      createdAt: safeFormatDateTime(event.createdAt),
      summary: event.summary ?? "No error summary provided.",
      rawData:
        event.data === undefined ? null : JSON.stringify(event.data, null, 2),
    })),
    sessionAgents,
    eventData,
    rawMetadata: session.metadata ? renderJson(session.metadata) : null,
  };
}

function renderJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function normalizeEventStatus(event: SyncedAgentSessionEvent): AgentStatus {
  const eventType = event.eventType.toLowerCase();
  if (eventType.includes("error") || eventType.includes("fail")) {
    return "error";
  }
  if (
    eventType.includes("complete") ||
    eventType.includes("success") ||
    eventType.includes("finish")
  ) {
    return "completed";
  }
  if (eventType.includes("wait") || eventType.includes("queued")) {
    return "waiting";
  }
  return "working";
}

function buildEventData(
  session: AgentSessionDetail,
  agentNames: Map<string, string>
): {
  facets: SessionEventFacets;
  groups: SessionEventGroup[];
  activeFilters: EventFilterSelection;
} {
  const events: SessionEvent[] = [...session.events]
    .sort(
      (left, right) =>
        getDateTime(right.createdAt) - getDateTime(left.createdAt)
    )
    .map((event) => {
      const createdAt = normalizeDateTimeString(event.createdAt);
      return {
        id: event.externalEventId,
        sessionId: session.id,
        agentId: event.agentExternalId,
        agentLabel: event.agentExternalId
          ? (agentNames.get(event.agentExternalId) ?? event.agentExternalId)
          : null,
        eventType: event.eventType,
        status: normalizeEventStatus(event),
        toolName: event.toolName,
        title: event.toolName ?? event.eventType,
        summary: event.summary,
        createdAt,
        rawData:
          event.data === undefined ? null : JSON.stringify(event.data, null, 2),
        metadata: event.toolName
          ? [{ label: "Tool", value: event.toolName }]
          : undefined,
      };
    });

  const grouped = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const groupKey = getLocalCalendarDateKey(event.createdAt);
    const bucket = grouped.get(groupKey);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(groupKey, [event]);
    }
  }

  const groups = [...grouped.entries()].map(([groupKey, groupEvents]) => ({
    id: groupKey,
    title: formatLocalCalendarGroupTitle(groupEvents[0]?.createdAt),
    events: groupEvents,
  }));

  return {
    facets: {
      statuses: [...new Set(events.map((event) => event.status))],
      eventTypes: [...new Set(events.map((event) => event.eventType))],
      toolNames: [
        ...new Set(
          events.map((event) => event.toolName).filter(Boolean) as string[]
        ),
      ],
      agents: [...agentNames.entries()].map(([id, label]) => ({ id, label })),
    },
    groups,
    activeFilters: {
      query: "",
      statuses: [],
      eventTypes: [],
      toolNames: [],
      agents: [],
    },
  };
}

function buildOverviewStats(
  session: AgentSessionDetail,
  toolInvocations: Array<{ toolName: string; count: number }>
): SessionOverviewStats {
  const totalDurationMs = Math.max(
    0,
    getDateTime(session.endedAt ?? session.updatedAt) -
      getDateTime(session.startedAt)
  );
  const totalMinutes = Math.max(totalDurationMs / 60_000, 1);
  const subagentTypes = new Map<string, number>();
  const eventMix = new Map<string, number>();
  let compactions = 0;
  for (const agent of session.agents) {
    const label =
      agent.subagentType ?? (agent.parentExternalAgentId ? agent.type : "main");
    subagentTypes.set(label, (subagentTypes.get(label) ?? 0) + 1);
    if (
      label.toLowerCase().includes("compact") ||
      agent.name.toLowerCase().includes("compact")
    ) {
      compactions += 1;
    }
  }
  for (const event of session.events) {
    eventMix.set(event.eventType, (eventMix.get(event.eventType) ?? 0) + 1);
  }

  const activeAgent = session.agents.find((agent) =>
    ["working", "active", "running"].some((token) =>
      agent.status.toLowerCase().includes(token)
    )
  );

  return {
    totalEvents: session.events.length,
    toolCalls: session.toolUseCount,
    subagents: Math.max(session.agentCount - 1, 0),
    compactions,
    errors: session.errorCount,
    durationLabel: formatDuration(session.startedAt, session.endedAt),
    eventRateHint: `${formatNumber(
      Math.round(session.events.length / totalMinutes)
    )} events / min`,
    topTools: toolInvocations.slice(0, 6),
    subagentTypes: [...subagentTypes.entries()].map(([label, count]) => ({
      label,
      count,
      isCompaction: label.toLowerCase().includes("compact"),
    })),
    tokens: {
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
    },
    eventMix: [...eventMix.entries()].map(([eventType, count]) => ({
      eventType,
      count,
    })),
    activeAgent: activeAgent
      ? {
          name: activeAgent.name,
          currentTool: activeAgent.currentTool,
          task: activeAgent.task,
        }
      : null,
  };
}

function buildToolInvocations(events: SyncedAgentSessionEvent[]) {
  const grouped = new Map<
    string,
    {
      toolName: string;
      count: number;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();
  for (const event of events) {
    const toolName = event.toolName?.trim();
    if (!toolName) {
      continue;
    }
    const createdAt = normalizeDateTimeString(event.createdAt);
    const existing = grouped.get(toolName);
    if (!existing) {
      grouped.set(toolName, {
        toolName,
        count: 1,
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
      });
      continue;
    }
    existing.count += 1;
    if (createdAt < existing.firstSeenAt) {
      existing.firstSeenAt = createdAt;
    }
    if (createdAt > existing.lastSeenAt) {
      existing.lastSeenAt = createdAt;
    }
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count);
}

function normalizeDateTimeString(
  date: Date | string | null | undefined
): string {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return parsed.toISOString();
}

/** Formats nullable or invalid session timestamps into a user-safe label. */
export function safeFormatDateTime(
  date: Date | string | null | undefined
): string {
  if (!date) {
    return "Unknown";
  }
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return formatDateTime(parsed);
}

function getDateTime(date: Date | string | null | undefined): number {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return 0;
  }
  return parsed.getTime();
}

function getLocalCalendarDateKey(date: Date | string | null | undefined) {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "unknown";
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalCalendarGroupTitle(date: Date | string | null | undefined) {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return formatDate(parsed);
}
