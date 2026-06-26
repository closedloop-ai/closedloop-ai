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
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS
): AgentCoachingGroundedMetrics {
  const analytics = input.analytics;
  const byDay = analytics?.tokens.byDay ?? [];
  // byDay is chronological; the trailing `lookbackDays` entries are the window.
  const windowDays = byDay.slice(-lookbackDays);
  const totalInputTokens = windowDays.reduce(
    (sum, day) => sum + day.inputTokens,
    0
  );
  const totalOutputTokens = windowDays.reduce(
    (sum, day) => sum + day.outputTokens,
    0
  );
  // When per-day token history is unavailable (empty window), fall back to the
  // aggregate. Guard with `> 0` so a genuine zero-token window isn't treated as
  // "missing" and overwritten by the aggregate.
  const inputTokens =
    windowDays.length > 0
      ? totalInputTokens
      : (analytics?.tokens.totalInputTokens ?? 0);
  const outputTokens =
    windowDays.length > 0
      ? totalOutputTokens
      : (analytics?.tokens.totalOutputTokens ?? 0);

  const costRows = (analytics?.tokens.byModel ?? []).filter(
    (model) => typeof model.estimatedCostUsd === "number"
  );
  const estimatedCostUsd =
    costRows.length > 0
      ? costRows.reduce((sum, model) => sum + (model.estimatedCostUsd ?? 0), 0)
      : null;

  return {
    lookbackDays: windowDays.length > 0 ? windowDays.length : lookbackDays,
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
