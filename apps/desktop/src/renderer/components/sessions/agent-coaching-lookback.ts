import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
} from "./agent-coaching-types";

const DEFAULT_LOOKBACK_DAYS = 30;
const SHELL_TOOL_PATTERN = /bash|exec_command|shell/i;
const RTK_PREFIX_PATTERN = /^\s*rtk\s/;
const WHITESPACE_PATTERN = /\s+/;
const REPEATED_FAMILY_MIN_COUNT = 3;
const TOP_FAMILY_LIMIT = 6;

/**
 * Reduce the local evidence to quantified, lookback-windowed facts the
 * generator can turn into concrete claims. Pure and deterministic so it can be
 * unit-tested without the DB or the harness.
 */
export function summarizeLookback(
  input: AgentCoachingInput,
  fallbackLookbackDays: number = DEFAULT_LOOKBACK_DAYS
): AgentCoachingGroundedMetrics {
  const analytics = input.analytics;
  const inputTokens = analytics?.tokens.totalInputTokens ?? 0;
  const outputTokens = analytics?.tokens.totalOutputTokens ?? 0;
  const byDay = analytics?.tokens.byDay ?? [];
  const estimatedCostUsd = sumOptionalCost(byDay);

  return {
    lookbackDays: analytics?.tokens.windowDays || fallbackLookbackDays,
    sessionsAnalyzed:
      analytics?.totalSessions ?? input.workflow?.stats.totalSessions ?? 0,
    eventsAnalyzed: analytics?.totalEvents ?? input.recentEvents.length,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd,
    avgSessionDurationSec: input.workflow?.stats.avgDurationSec ?? null,
    unwrappedShellCommandRatio: computeUnwrappedShellRatio(input.recentEvents),
    repeatedCommandFamilies: computeRepeatedFamilies(input.recentEvents),
    totalSkillInvocations: input.skills.reduce(
      (sum, skill) => sum + skill.invocationCount,
      0
    ),
  };
}

/**
 * Sum `estimatedCostUsd` over rows that actually carry it. Returns null when no
 * row has a numeric cost, so callers can omit the cost claim rather than report
 * a misleading $0.
 */
function sumOptionalCost(
  rows: ReadonlyArray<{ estimatedCostUsd?: number }>
): number | null {
  const costRows = rows.filter(
    (row) => typeof row.estimatedCostUsd === "number"
  );
  return costRows.length > 0
    ? costRows.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)
    : null;
}

function commandText(
  event: AgentCoachingInput["recentEvents"][number]
): string {
  return event.summary ?? event.data ?? event.toolName ?? "";
}

function isShellEvent(
  event: AgentCoachingInput["recentEvents"][number]
): boolean {
  return Boolean(event.toolName && SHELL_TOOL_PATTERN.test(event.toolName));
}

/**
 * Fraction of shell commands NOT already routed through `rtk`. Null when there
 * are no shell commands to reason about (so the generator can omit the claim).
 */
function computeUnwrappedShellRatio(
  events: AgentCoachingInput["recentEvents"]
): number | null {
  const shellCommands = events.filter(isShellEvent).map(commandText);
  if (shellCommands.length === 0) {
    return null;
  }
  const unwrapped = shellCommands.filter(
    (command) => !RTK_PREFIX_PATTERN.test(command)
  ).length;
  return unwrapped / shellCommands.length;
}

function computeRepeatedFamilies(
  events: AgentCoachingInput["recentEvents"]
): AgentCoachingGroundedMetrics["repeatedCommandFamilies"] {
  const families = new Map<string, { count: number; totalChars: number }>();
  for (const event of events) {
    if (!isShellEvent(event)) {
      continue;
    }
    const command = commandText(event).trim();
    const family = commandFamily(command);
    if (!family) {
      continue;
    }
    const existing = families.get(family) ?? { count: 0, totalChars: 0 };
    existing.count += 1;
    existing.totalChars += command.length;
    families.set(family, existing);
  }

  return [...families.entries()]
    .filter(([, stats]) => stats.count >= REPEATED_FAMILY_MIN_COUNT)
    .map(([family, stats]) => ({
      family,
      count: stats.count,
      avgCommandChars: Math.round(stats.totalChars / stats.count),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_FAMILY_LIMIT);
}

/** First meaningful command token, ignoring an `rtk` wrapper prefix. */
function commandFamily(command: string): string {
  const tokens = command.split(WHITESPACE_PATTERN).filter(Boolean);
  const offset = tokens[0] === "rtk" ? 1 : 0;
  const head = tokens[offset];
  const sub = tokens[offset + 1];
  if (!head) {
    return "";
  }
  if ((head === "git" || head === "gh" || head === "pnpm") && sub) {
    return `${head} ${sub}`;
  }
  return head;
}
