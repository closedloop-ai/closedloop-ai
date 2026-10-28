import type {
  AnalyticsData,
  EventWithSession,
  TokenAnalytics,
  WorkflowQueryData,
} from "../../../../../shared/agent-db-contract";
import type { AgentCoachingInput } from "../../agent-coaching-types";

/**
 * The coaching input fixtures shared by the lookback, generation and model
 * suites: one analytics payload whose per-day cost (4.5) differs from its
 * all-time spend (9) so a windowed claim can be told from a lifetime one, and
 * event builders for each event shape the reducers classify.
 */
export const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");

/** A user turn that clears the frustration threshold on its own. */
export const FRUSTRATED_TURN = "STOP. this is WRONG again, revert it please!!";

const EVENT_AT = "2026-06-17T00:00:00.000Z";

export function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: [],
    skills: [{ invocationCount: 4 }],
    workflow: makeWorkflow(),
    ...overrides,
  };
}

/** The default input with only the token analytics changed. */
export function makeInputWithTokens(
  tokens: Partial<TokenAnalytics>
): AgentCoachingInput {
  const analytics = makeAnalytics();
  return makeInput({
    analytics: { ...analytics, tokens: { ...analytics.tokens, ...tokens } },
  });
}

export function makeAnalytics(): AnalyticsData {
  return {
    agentsByStatus: [],
    agentsByType: [],
    dailyEvents: [],
    eventsByType: [],
    sessionsByStatus: [],
    toolUsage: [],
    tokens: {
      byDay: [
        {
          day: "2026-06-16",
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 1.5,
        },
        {
          day: "2026-06-17",
          inputTokens: 200,
          outputTokens: 100,
          estimatedCostUsd: 3,
        },
      ],
      // All-time spend is higher than the per-day window sum (4.5) so tests can
      // prove the windowed cost comes from byDay, not this lifetime total.
      byModel: [
        {
          estimatedCostUsd: 9,
          inputTokens: 300,
          model: "claude-sonnet-4-5",
          outputTokens: 150,
          sessions: 2,
        },
      ],
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      windowDays: 30,
    },
    totalAgents: 4,
    totalEvents: 40,
    totalSessions: 2,
  };
}

// Older per-day rows can predate cost estimation and lack estimatedCostUsd.
export function makeAnalyticsWithoutPerDayCost(): AnalyticsData {
  const analytics = makeAnalytics();
  return {
    ...analytics,
    tokens: {
      ...analytics.tokens,
      byDay: analytics.tokens.byDay.map(
        ({ estimatedCostUsd: _drop, ...rest }) => rest
      ),
    },
  };
}

/**
 * Token totals large enough that the group separator is observable. The shared
 * `makeInput` fixture totals 450, which every locale renders the same way.
 * `summarizeLookback` reads these payload fields directly rather than re-slicing
 * `byDay`, so the prompt carries exactly these three grouped figures.
 */
export function makeGroupedTokenInput(): AgentCoachingInput {
  return makeInputWithTokens({
    totalInputTokens: 1_234_567,
    totalOutputTokens: 7_654_321,
  });
}

export function makeWorkflow(): WorkflowQueryData {
  return {
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
      mainCount: 2,
      outcomes: [],
      sessionCount: 2,
      subagentTypes: [],
    },
    stats: {
      avgCompactions: 0,
      avgDepth: 1,
      avgDurationSec: 120,
      avgSubagents: 1,
      successRate: 0.9,
      totalAgents: 4,
      totalCompactions: 0,
      totalSessions: 2,
      totalSubagents: 2,
    },
  };
}

export function shellEvent(
  summary: string,
  sessionId = "session-1"
): EventWithSession {
  return makeEvent({
    eventType: "tool_use",
    id: `event-${summary}-${sessionId}`,
    sessionId,
    summary,
    toolName: "Bash",
  });
}

/** A shell event whose data is a blob with no recoverable command. */
export function commandlessShellEvent(sessionId?: string): EventWithSession {
  return {
    ...shellEvent("ignored", sessionId),
    data: '{"session_id":"s-1","tool_input":{"cwd":"/tmp"}}',
    summary: null,
  };
}

let eventSeq = 0;

export function userEvent(summary: string): EventWithSession {
  eventSeq += 1;
  return makeEvent({
    eventType: "UserMessage",
    id: `user-event-${eventSeq}`,
    summary,
  });
}

export function errorEvent(): EventWithSession {
  eventSeq += 1;
  return makeEvent({
    eventType: "error",
    id: `error-event-${eventSeq}`,
    summary: "command failed",
  });
}

// A tool-call event carrying an arbitrary toolName (FEA-3397 plan-mode detect).
export function toolEvent(
  toolName: string,
  sessionId = "session-1"
): EventWithSession {
  return makeEvent({
    eventType: "PreToolUse",
    id: `tool-${toolName}-${sessionId}`,
    sessionId,
    toolName,
  });
}

export function planEvent(sessionId = "session-1"): EventWithSession {
  return toolEvent("ExitPlanMode", sessionId);
}

// A human-turn event (eventRole → "human") carrying prompt text.
export function promptEvent(
  text: string,
  sessionId = "session-1"
): EventWithSession {
  return makeEvent({
    eventType: "UserPromptSubmit",
    id: `prompt-${text}-${sessionId}`,
    sessionId,
    summary: text,
  });
}

export function timestampedEvent(createdAt: string | null): EventWithSession {
  return makeEvent({
    createdAt,
    eventType: "tool_use",
    id: `ts-${createdAt}`,
    summary: "activity",
    toolName: "Bash",
  });
}

// Build an ISO string from LOCAL date components so hour bucketing is
// timezone-independent in the test (cadence uses local getHours/getDay).
export function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour: number
): string {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).toISOString();
}

function makeEvent(
  overrides: Partial<EventWithSession> &
    Pick<EventWithSession, "eventType" | "id">
): EventWithSession {
  return {
    agentId: null,
    createdAt: EVENT_AT,
    data: null,
    sessionId: "session-1",
    sessionName: "Session",
    summary: null,
    toolName: null,
    ...overrides,
  };
}
