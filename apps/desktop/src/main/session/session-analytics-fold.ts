/**
 * The canonical local analytics fold, in its windowed form.
 *
 * ISS-6895: extracted from `shared-agent-sessions-api.ts` (a shrink-only
 * grandfathered file) and reshaped from "one array in, one response out" into an
 * accumulator the read layer can drive ONE HYDRATION WINDOW AT A TIME. Every
 * member of {@link AnalyticsFold} is keyed by a dimension (tool, agent type,
 * repository), so its size is bounded by the corpus's cardinality and never by
 * its row count — which is what lets analytics cover a matched population larger
 * than any single hydration window without retaining it.
 *
 * "Never by its row count" binds the VALUES too: every distinct-session count is
 * a plain counter, deduplicated within the session that increments it. Holding a
 * `Set` of session id per tool group instead made the fold O(rows) — and worse
 * than the other folds, since a session retained an id in EVERY tool group it
 * touched — which is precisely the corpus-sized residency this rewrite removes.
 *
 * `buildAnalytics` stays as the whole-array entry point, implemented as the same
 * fold, so the windowed and non-windowed paths cannot drift.
 */
import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  AGENT_FAILED_STATUS_PATTERN as FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN as SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import type {
  SharedAgentSessionAgentTypeBreakdown,
  SharedAgentSessionAnalytics,
  SharedAgentSessionRepositoryBreakdown,
  SharedAgentSessionToolBreakdown,
} from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { parseSessionDate } from "./session-instant.js";
import { sessionRepositoryName } from "./session-repository-facet.js";
import { sumTokenUsage } from "./session-usage-totals.js";

export type AnalyticsFold = {
  toolGroups: Map<string, ToolBreakdownGroup>;
  agentTypeGroups: Map<string, AgentTypeBreakdownGroup>;
  repositoryGroups: Map<string, SharedAgentSessionRepositoryBreakdown>;
};

export function createAnalyticsFold(): AnalyticsFold {
  return {
    toolGroups: new Map(),
    agentTypeGroups: new Map(),
    repositoryGroups: new Map(),
  };
}

// FEA-3869: fold the per-tool, per-agent-type, and per-repository breakdowns in a
// single pass over the hydrated working set. Tool and repository error tallies
// share one inner `events` loop (each session's `events` array is scanned once,
// not twice), replacing the former three separate passes plus a second
// `countErrorEvents` scan on the largest-dimension corpus.
export function addSessionToAnalyticsFold(
  fold: AnalyticsFold,
  session: SyncedAgentSession
): void {
  const repositoryGroup = accumulateRepositoryTotals(
    fold.repositoryGroups,
    session
  );
  accumulateSessionEvents(session, fold.toolGroups, repositoryGroup);
  accumulateSessionAgents(session, fold.agentTypeGroups);
}

export function finishAnalyticsFold(
  fold: AnalyticsFold
): SharedAgentSessionAnalytics {
  return {
    viewerScope: "self",
    byTool: [...fold.toolGroups.values()],
    byAgentType: [...fold.agentTypeGroups.values()].map(
      stripAgentTypeDurationFields
    ),
    byRepository: [...fold.repositoryGroups.values()],
    byProject: [],
  };
}

export function buildAnalytics(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionAnalytics {
  const fold = createAnalyticsFold();
  for (const session of sessions) {
    addSessionToAnalyticsFold(fold, session);
  }
  return finishAnalyticsFold(fold);
}

type ToolBreakdownGroup = SharedAgentSessionToolBreakdown;

type AgentTypeBreakdownGroup = SharedAgentSessionAgentTypeBreakdown & {
  durationTotalMs: number;
  durationCount: number;
};

function accumulateRepositoryTotals(
  repositoryGroups: Map<string, SharedAgentSessionRepositoryBreakdown>,
  session: SyncedAgentSession
): SharedAgentSessionRepositoryBreakdown | null {
  // FEA-4299: skip a session with no facet repo identity (see
  // `sessionRepositoryName`); it renders "Unknown" and is not a facet option.
  const repositoryFullName = sessionRepositoryName(session);
  if (repositoryFullName === null) {
    return null;
  }
  const totals = sumTokenUsage(session);
  const group = repositoryGroups.get(repositoryFullName) ?? {
    repositoryFullName,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    errorCount: 0,
  };
  group.sessionCount += 1;
  group.inputTokens += totals.inputTokens;
  group.outputTokens += totals.outputTokens;
  group.estimatedCost += totals.estimatedCost;
  repositoryGroups.set(repositoryFullName, group);
  return group;
}

// Single scan of `session.events`: every error event feeds the repository error
// count, and tool-attributed events additionally feed the per-tool rollup — so
// the corpus is walked once for both dimensions.
function accumulateSessionEvents(
  session: SyncedAgentSession,
  toolGroups: Map<string, ToolBreakdownGroup>,
  repositoryGroup: SharedAgentSessionRepositoryBreakdown | null
): void {
  // ISS-6895: a session invokes the same tool many times, so its per-tool
  // distinct-session count needs deduplication — but only WITHIN this session.
  // This local set is bounded by the tools ONE session used and is released with
  // it, where the former per-group `Set<sessionId>` retained an id per row in
  // every tool group the session touched, for the whole read.
  const countedTools = new Set<string>();
  for (const event of session.events) {
    const isError = ERROR_EVENT_PATTERN.test(event.eventType);
    // `repositoryGroup` is null for a session with no facet repo identity
    // (FEA-4299); its errors are still counted per tool below, just not rolled
    // into a repository bucket the facet does not expose.
    if (isError && repositoryGroup) {
      repositoryGroup.errorCount += 1;
    }
    if (!event.toolName) {
      continue;
    }
    const group = toolGroups.get(event.toolName) ?? {
      toolName: event.toolName,
      invocationCount: 0,
      errorCount: 0,
      sessionCount: 0,
    };
    group.invocationCount += 1;
    if (isError) {
      group.errorCount += 1;
    }
    if (!countedTools.has(event.toolName)) {
      countedTools.add(event.toolName);
      group.sessionCount += 1;
    }
    toolGroups.set(event.toolName, group);
  }
}

function accumulateSessionAgents(
  session: SyncedAgentSession,
  agentTypeGroups: Map<string, AgentTypeBreakdownGroup>
): void {
  for (const agent of session.agents) {
    const agentType = agent.subagentType ?? agent.type ?? "unknown";
    const group = agentTypeGroups.get(agentType) ?? {
      agentType,
      count: 0,
      successCount: 0,
      failedCount: 0,
      avgDurationMs: null,
      durationTotalMs: 0,
      durationCount: 0,
    };
    group.count += 1;
    if (SUCCESS_STATUS_PATTERN.test(agent.status)) {
      group.successCount += 1;
    }
    if (FAILED_STATUS_PATTERN.test(agent.status)) {
      group.failedCount += 1;
    }
    const durationMs = durationBetween(agent.startedAt, agent.endedAt);
    if (durationMs !== null) {
      group.durationTotalMs += durationMs;
      group.durationCount += 1;
      group.avgDurationMs = group.durationTotalMs / group.durationCount;
    }
    agentTypeGroups.set(agentType, group);
  }
}

function stripAgentTypeDurationFields(
  group: AgentTypeBreakdownGroup
): SharedAgentSessionAgentTypeBreakdown {
  const {
    durationCount: _durationCount,
    durationTotalMs: _durationTotalMs,
    ...rest
  } = group;
  return rest;
}

function durationBetween(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = parseSessionDate(startedAt);
  const end = parseSessionDate(endedAt);
  const durationMs = end.getTime() - start.getTime();
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}
