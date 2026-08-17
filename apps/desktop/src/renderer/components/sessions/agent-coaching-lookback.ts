import { eventRole } from "../../../shared/event-role";
import {
  countNearbyErrors,
  frustrationScore,
} from "../../../shared/frustration-score";
import { extractShellCommand } from "./agent-coaching-model";
import { redactSecrets } from "./agent-coaching-redaction";
import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
  PeakFrustrationSignal,
} from "./agent-coaching-types";

const DEFAULT_LOOKBACK_DAYS = 30;
const SHELL_TOOL_PATTERN = /bash|exec_command|shell/i;
const RTK_PREFIX_PATTERN = /^\s*rtk\s/;
const WHITESPACE_PATTERN = /\s+/;
const REPEATED_FAMILY_MIN_COUNT = 3;
const TOP_FAMILY_LIMIT = 6;

// FEA-3399: frustration heuristic. A user turn scores on "stop"/"again"-class
// language, shouting (long ALL-CAPS runs), and pleading punctuation; nearby
// error-event spikes amplify it. Tuned to only fire on a genuinely confident
// peak, never a forced "crash out".
const USER_EVENT_PATTERN = /user|prompt|steer/i;
// Minimum score before a peak is surfaced at all — keeps the resilience tip off
// unless the evidence is confident (no forced/fake "crash out").
const FRUSTRATION_MIN_SCORE = 2;
const FRUSTRATION_EXCERPT_MAX_CHARS = 160;
const WHITESPACE_RUN_PATTERN = /\s+/g;
// FEA-3397 fun-fact tuning.
// Plan mode surfaces in the renderer event stream as a tool marker
// (Claude's ExitPlanMode, Codex's update_plan) — never as a permission-mode
// field, which does not cross the renderer DB contract. Absence of ANY marker
// means "undetectable" (planModeRatio = null), NOT "never used plan mode".
const PLAN_MODE_MARKER_PATTERN =
  /exit_?plan_?mode|update_?plan|\bplan[_ ]?mode\b/i;
const TOP_PROMPT_LIMIT = 5;
const MAX_PROMPT_PREVIEW_CHARS = 120;
// Local hours [0, 6) count as "middle of the night" (Paxel's night-owl card).
const NIGHT_OWL_END_HOUR = 6;
const NIGHT_OWL_LABEL_THRESHOLD = 0.25;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * FEA-3722 / FEA-2345: resolve the window label (in days) the Wrap header shows.
 *
 * The DB-reported `windowDays` is authoritative when present and positive: the
 * analytics query already windowed to the caller's selected range (loadTips
 * passes the same lookback to getAnalytics and here), so the payload reflects
 * the real window. That preserves the FEA-2345 contract that the payload wins.
 *
 * The reported window is 0 for an all-time query (the "unbounded" sentinel);
 * in that case — or when analytics is absent — fall back to the requested
 * range: `null` (all-time) maps to 0 so the header reads "all time"; a positive
 * request is used directly; otherwise the 30-day default.
 */
function resolveLookbackDays(
  requestedLookbackDays: number | null | undefined,
  reportedWindowDays: number | undefined
): number {
  if (typeof reportedWindowDays === "number" && reportedWindowDays > 0) {
    return reportedWindowDays;
  }
  if (requestedLookbackDays === null) {
    return 0;
  }
  if (
    typeof requestedLookbackDays === "number" &&
    Number.isFinite(requestedLookbackDays) &&
    requestedLookbackDays > 0
  ) {
    return requestedLookbackDays;
  }
  return DEFAULT_LOOKBACK_DAYS;
}

/**
 * Reduce the local evidence to quantified, lookback-windowed facts the
 * generator can turn into concrete claims. Pure and deterministic so it can be
 * unit-tested without the DB or the harness.
 */
export function summarizeLookback(
  input: AgentCoachingInput,
  // FEA-3722: the caller's selected window, used ONLY to label an all-time or
  // analytics-absent load — the DB-reported `windowDays` stays authoritative
  // when present (FEA-2345). `null` means all-time; a positive number is that
  // many days; `undefined` falls back to the 30-day default. See
  // resolveLookbackDays.
  requestedLookbackDays?: number | null
): AgentCoachingGroundedMetrics {
  const analytics = input.analytics;
  const inputTokens = analytics?.tokens.totalInputTokens ?? 0;
  const outputTokens = analytics?.tokens.totalOutputTokens ?? 0;
  const byDay = analytics?.tokens.byDay ?? [];
  const estimatedCostUsd = sumOptionalCost(byDay);

  return {
    lookbackDays: resolveLookbackDays(
      requestedLookbackDays,
      analytics?.tokens.windowDays
    ),
    // FEA-3837: sessionsAnalyzed/eventsAnalyzed/avgSessionDurationSec are
    // ALL-TIME aggregates (getAnalytics `totalSessions`/`totalEvents` are
    // unwindowed row counts; getWorkflowData `avgDurationSec` averages over all
    // sessions), NOT windowed to the selected lookback like the token totals.
    // The prompt (renderAgentCoachingPrompt) labels them as lifetime totals so
    // they are never framed as within-window. When analytics is unavailable
    // `eventsAnalyzed` falls back to `recentEvents.length` — the latest ≤200
    // captured events (getEventFeed), a SAMPLE and NOT an all-time total — so
    // `eventsAnalyzedIsAllTime` records which of the two the value is, and the
    // prompt labels the fallback as a sample rather than lying with "all time".
    sessionsAnalyzed:
      analytics?.totalSessions ?? input.workflow?.stats.totalSessions ?? 0,
    eventsAnalyzed: analytics?.totalEvents ?? input.recentEvents.length,
    eventsAnalyzedIsAllTime: analytics?.totalEvents != null,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd,
    avgSessionDurationSec: input.workflow?.stats.avgDurationSec ?? null,
    unwrappedShellCommandRatio: computeUnwrappedShellRatio(input.recentEvents),
    shellCommandsSampled: countShellCommandsSampled(input.recentEvents),
    repeatedCommandFamilies: computeRepeatedFamilies(input.recentEvents),
    // A failed skills read is unavailable (null), never a false 0 — see
    // AgentCoachingInput.skillsUnavailable.
    totalSkillInvocations: input.skillsUnavailable
      ? null
      : input.skills.reduce((sum, skill) => sum + skill.invocationCount, 0),
    peakFrustration: computePeakFrustration(input.recentEvents),
    modelMix: computeModelMix(analytics),
    planModeRatio: computePlanModeRatio(input.recentEvents),
    topPrompts: computeTopPrompts(input.recentEvents),
    sessionCadence: computeSessionCadence(input.recentEvents),
  };
}

/**
 * True only when there is at least one substantive signal to ground a coaching
 * tip in — any analyzed session, any analyzed event, any token spend, or any
 * captured recent event. When ALL of these are empty/zero the local corpus is
 * blank, so the generator has nothing to make a concrete, QUANTIFIED claim about
 * (the prompt's hard requirement) and the model correctly refuses.
 *
 * The caller uses this to short-circuit BEFORE spawning the local `claude -p`
 * harness: an empty-activity load must not burn a multi-round, ~9s-each LLM call
 * only to be refused — it falls back to the built-in seed tips instead. Kept
 * pure (derives solely from `summarizeLookback`) so it is unit-testable without
 * the DB or the harness, and deliberately conservative (requires EVERY signal to
 * be empty) so legitimate tips are never suppressed.
 */
export function hasSubstantiveCoachingActivity(
  input: AgentCoachingInput
): boolean {
  return (
    groundedMetricsHaveActivity(summarizeLookback(input)) ||
    input.recentEvents.length > 0
  );
}

/**
 * Whether already-computed lookback metrics reflect any real local activity to
 * ground a tip in. The renderer calls this on the `groundedMetrics` a load
 * already returned to decide whether coaching has data yet or must keep WAITING
 * for the local corpus to populate: on the desktop startup race the coaching
 * panel mounts before the SQLite backfill finishes, so the first read sees an
 * empty corpus. Metrics-only + null-safe (null = "nothing computed yet, keep
 * waiting") so the component can reuse it without re-deriving anything, and it
 * shares the exact session/event/token signal `hasSubstantiveCoachingActivity`
 * gates generation on, so the "kick off yet?" and "wait?" decisions never drift.
 */
export function groundedMetricsHaveActivity(
  metrics: AgentCoachingGroundedMetrics | null
): boolean {
  return (
    metrics !== null &&
    (metrics.sessionsAnalyzed > 0 ||
      metrics.eventsAnalyzed > 0 ||
      metrics.totalTokens > 0)
  );
}

/**
 * FEA-3399: find the single user turn with the highest heuristic frustration
 * score across the lookback window — Paxel's "your biggest crash out". Returns
 * null when no turn clears `FRUSTRATION_MIN_SCORE`, so the resilience tip is
 * only emitted on a confident peak rather than a forced one. The surviving
 * excerpt is redacted so no raw prompt text leaves the device.
 */
export function computePeakFrustration(
  events: AgentCoachingInput["recentEvents"]
): PeakFrustrationSignal | null {
  let best: PeakFrustrationSignal | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isUserEvent(event)) {
      continue;
    }
    const text = userTurnText(event);
    if (!text) {
      continue;
    }
    const nearbyErrorCount = countNearbyErrors(events, index);
    const score = frustrationScore(text) + nearbyErrorCount;
    if (score < FRUSTRATION_MIN_SCORE) {
      continue;
    }
    if (!best || score > best.score) {
      best = {
        score,
        nearbyErrorCount,
        excerpt: redactExcerpt(text),
        sessionName: event.sessionName,
      };
    }
  }
  return best;
}

function isUserEvent(
  event: AgentCoachingInput["recentEvents"][number]
): boolean {
  return USER_EVENT_PATTERN.test(event.eventType);
}

function userTurnText(
  event: AgentCoachingInput["recentEvents"][number]
): string {
  return (event.summary ?? event.data ?? "").trim();
}

/** Redact secrets, collapse whitespace, and cap the length of the excerpt. */
function redactExcerpt(text: string): string {
  const redacted = redactSecrets(text)
    .replace(WHITESPACE_RUN_PATTERN, " ")
    .trim();
  if (redacted.length <= FRUSTRATION_EXCERPT_MAX_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, FRUSTRATION_EXCERPT_MAX_CHARS)}…`;
}

/**
 * Token share per model over the window (favorite model). Derived from the
 * per-model token attribution already in analytics — null when there is none,
 * so the generator omits the claim rather than inventing a model.
 */
function computeModelMix(
  analytics: AgentCoachingInput["analytics"]
): AgentCoachingGroundedMetrics["modelMix"] {
  const byModel = analytics?.tokens.byModel ?? [];
  const rows = byModel
    .map((entry) => ({
      model: entry.model,
      tokens: entry.inputTokens + entry.outputTokens,
      sessions: entry.sessions,
    }))
    .filter((row) => row.tokens > 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (rows.length === 0 || totalTokens === 0) {
    return null;
  }
  return rows
    .map((row) => ({
      model: row.model,
      tokens: row.tokens,
      share: row.tokens / totalTokens,
      sessions: row.sessions,
    }))
    .sort((a, b) => b.share - a.share || a.model.localeCompare(b.model));
}

/**
 * Fraction of analyzed sessions (grouped by sessionId) that show a plan-mode
 * marker. Returns null — never a false `false` — when no plan marker appears in
 * ANY event, since a harness that does not surface plan markers must read as
 * "undetectable", not "0% plan mode".
 */
function computePlanModeRatio(
  events: AgentCoachingInput["recentEvents"]
): number | null {
  const sessionsWithMarker = new Set<string>();
  const allSessions = new Set<string>();
  let sawAnyMarker = false;
  for (const event of events) {
    allSessions.add(event.sessionId);
    if (isPlanModeEvent(event)) {
      sawAnyMarker = true;
      sessionsWithMarker.add(event.sessionId);
    }
  }
  if (!sawAnyMarker || allSessions.size === 0) {
    return null;
  }
  return sessionsWithMarker.size / allSessions.size;
}

function isPlanModeEvent(
  event: AgentCoachingInput["recentEvents"][number]
): boolean {
  const haystack = `${event.toolName ?? ""} ${event.summary ?? ""}`;
  return PLAN_MODE_MARKER_PATTERN.test(haystack);
}

/**
 * Most-frequent normalized user prompts + average prompt length, from human
 * turns (`eventRole` SSOT). Prompt text is redacted and truncated so nothing
 * raw leaves local generation. Null when no user-turn text is captured.
 */
function computeTopPrompts(
  events: AgentCoachingInput["recentEvents"]
): AgentCoachingGroundedMetrics["topPrompts"] {
  const prompts = events
    .filter((event) => eventRole(event.eventType) === "human")
    .map((event) => (event.summary ?? event.data ?? "").trim())
    .filter((text) => text.length > 0);
  if (prompts.length === 0) {
    return null;
  }

  const totalChars = prompts.reduce((sum, text) => sum + text.length, 0);
  const counts = new Map<string, { text: string; count: number }>();
  for (const text of prompts) {
    const key = normalizePrompt(text);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        text: truncatePrompt(redactSecrets(text)),
        count: 1,
      });
    }
  }

  const ranked = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, TOP_PROMPT_LIMIT);
  return {
    prompts: ranked,
    avgPromptChars: Math.round(totalChars / prompts.length),
  };
}

/** Collapse whitespace + lowercase so trivially-different prompts group. */
function normalizePrompt(text: string): string {
  return text.toLowerCase().replace(WHITESPACE_PATTERN, " ").trim();
}

function truncatePrompt(text: string): string {
  const collapsed = text.replace(WHITESPACE_PATTERN, " ").trim();
  return collapsed.length <= MAX_PROMPT_PREVIEW_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_PROMPT_PREVIEW_CHARS)}…`;
}

/**
 * Hour-of-day / day-of-week activity histogram over event timestamps, plus a
 * derived cadence label ("night owl", "early bird", peak weekday). Null when no
 * event carries a parseable `createdAt`.
 */
function computeSessionCadence(
  events: AgentCoachingInput["recentEvents"]
): AgentCoachingGroundedMetrics["sessionCadence"] {
  const byHour = new Array<number>(HOURS_PER_DAY).fill(0);
  const byWeekday = new Array<number>(DAYS_PER_WEEK).fill(0);
  let total = 0;
  let nightCount = 0;
  for (const event of events) {
    if (!event.createdAt) {
      continue;
    }
    const date = new Date(event.createdAt);
    if (Number.isNaN(date.getTime())) {
      continue;
    }
    const hour = date.getHours();
    byHour[hour] += 1;
    byWeekday[date.getDay()] += 1;
    total += 1;
    if (hour < NIGHT_OWL_END_HOUR) {
      nightCount += 1;
    }
  }
  if (total === 0) {
    return null;
  }
  const nightOwlRatio = nightCount / total;
  return {
    byHour,
    byWeekday,
    nightOwlRatio,
    label: cadenceLabel(byHour, byWeekday, nightOwlRatio),
  };
}

function cadenceLabel(
  byHour: number[],
  byWeekday: number[],
  nightOwlRatio: number
): string {
  if (nightOwlRatio >= NIGHT_OWL_LABEL_THRESHOLD) {
    return `night owl: ${Math.round(nightOwlRatio * 100)}% of activity after midnight`;
  }
  const peakHour = indexOfMax(byHour);
  const peakWeekday = indexOfMax(byWeekday);
  return `most active around ${formatHour(peakHour)} on ${WEEKDAY_LABELS[peakWeekday]}`;
}

function indexOfMax(counts: number[]): number {
  let bestIndex = 0;
  let best = counts[0] ?? 0;
  for (let i = 1; i < counts.length; i += 1) {
    if ((counts[i] ?? 0) > best) {
      best = counts[i] ?? 0;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function formatHour(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}${suffix}`;
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

function isShellEvent(
  event: AgentCoachingInput["recentEvents"][number]
): boolean {
  return Boolean(event.toolName && SHELL_TOOL_PATTERN.test(event.toolName));
}

/**
 * The real shell commands in the sample. Uses `extractShellCommand` (not the
 * raw `event.data`) so a serialized tool event — `{"tool_input":{"command":
 * "rtk git status"}}` with `summary: null` — is tested as its actual command,
 * not as a JSON blob (which would never match the rtk prefix and count as a
 * false unwrapped command). Events with no recoverable command are dropped.
 */
function sampledShellCommands(
  events: AgentCoachingInput["recentEvents"]
): string[] {
  const commands: string[] = [];
  for (const event of events) {
    if (!isShellEvent(event)) {
      continue;
    }
    const command = extractShellCommand(event);
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}

/** Count of shell commands the unwrapped ratio was measured over. */
function countShellCommandsSampled(
  events: AgentCoachingInput["recentEvents"]
): number {
  return sampledShellCommands(events).length;
}

/**
 * Fraction of shell commands NOT already routed through `rtk`. Null when there
 * are no shell commands to reason about (so the generator can omit the claim).
 */
function computeUnwrappedShellRatio(
  events: AgentCoachingInput["recentEvents"]
): number | null {
  const shellCommands = sampledShellCommands(events);
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
    // Use the recovered shell command (not the raw serialized event) so a
    // `{"tool_input":{"command":…}}` blob is classified by its real command,
    // matching the unwrapped-ratio path and findReusableCommandCandidate.
    const command = extractShellCommand(event)?.trim();
    if (!command) {
      continue;
    }
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
