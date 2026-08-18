/**
 * Pure string/formatting helpers for the session-detail activity timeline's
 * throttle and limit dots (FEA-3642). Extracted from `agent-session-detail-view`
 * so the label-formatting responsibility lives in its own cohesive module and
 * the view file stays smaller. No React — the label/guard primitives plus the
 * domain-aware limit-label resolvers the limit-dot builders compose.
 */

import type {
  SessionTraceThrottleSource,
  SyncedAgentSessionEvent,
  TurnItem,
} from "@repo/api/src/types/agent-session";

const LIMIT_LABEL_SPLIT_REGEX = /[-_.\s]+/;

// FEA-3642: only STRUCTURED limit signals count. This matches a machine limit
// classification, never free prose that merely mentions limits.
const LIMIT_SIGNAL_TEXT_REGEX =
  /(?:session[-_.\s]?limit|usage[-_.\s]?limit|rate[-_.\s]?limit|rate limited|throttl|\b429\b)/i;
// FEA-3642: only genuinely structured classification fields the harness sets on
// `data` — NOT free-prose fields (`message`/`reason`/`error`), which would
// re-introduce the false positives this fix removes. Aligned with the desktop
// producer's `extractThrottleSources`, which reads `limitKind`/`type`/
// `errorCode`/`code`/`statusCode`.
const LIMIT_DATA_TEXT_KEYS = [
  "type",
  "limitKind",
  "code",
  "errorCode",
  "status",
  "statusCode",
] as const;

/**
 * A throttle's paused duration in minutes as a short human label, or `null` when
 * the value is absent/non-positive. Sub-minute pauses render "<1m"; otherwise the
 * value is rounded to the nearest whole minute ("3m").
 */
export function formatThrottleDuration(value: number): string | null {
  if (!(Number.isFinite(value) && value > 0)) {
    return null;
  }
  if (value < 1) {
    return "<1m";
  }
  return `${Math.round(value)}m`;
}

/**
 * Title-case a machine limit label (`usage_limit` → "Usage Limit"), splitting on
 * `-`/`_`/`.`/whitespace. Returns `null` for an empty/absent value.
 */
export function formatLimitLabelText(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .split(LIMIT_LABEL_SPLIT_REGEX)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** `"HTTP 429"` for a finite status code, else `null`. */
export function formatStatusCodeLabel(
  value: number | null | undefined
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `HTTP ${value}`;
}

/** True when `value` is a string with non-whitespace content. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A synced throttle-source's human limit label (title + provider/status). */
export function formatThrottleSourceLimitLabel(
  source: SessionTraceThrottleSource
): string {
  const title =
    formatLimitLabelText(source.limitKind) ??
    formatLimitLabelText(source.errorCode) ??
    formatLimitLabelText(source.sourceType) ??
    "Session limit";
  const details = [
    source.provider,
    formatStatusCodeLabel(source.statusCode),
  ].filter(isNonEmptyString);
  if (details.length > 0) {
    return `${title} (${details.join(", ")})`;
  }
  return title;
}

// FEA-3642: a synced event's `eventType` is the harness's structured
// classification of the event (e.g. `usage_limit`, `provider.rate_limit`,
// `session_trace.throttle`), produced by the same desktop pipeline that feeds
// `throttleSources` (`apps/desktop/.../session-trace.ts:extractThrottleSources`).
// It is the authoritative "this event IS a limit" signal — unlike the free-text
// `summary`/`title`/`text`/`toolName`, which merely *mention* limits (a tool's
// output, a GitHub "secondary rate limit" message, or the agent discussing 429s)
// and produced false-positive limit dots. We match ONLY structured signals
// (`eventType` + structured `data` fields), never conversational prose.
export function getSessionEventLimitLabel(
  event: SyncedAgentSessionEvent
): string | null {
  const dataText = getLimitDataText(event.data);
  const matched = firstLimitText([event.eventType, dataText]);
  if (!matched) {
    return null;
  }
  // Label preference stays structured: the harness event type first, then the
  // structured `data` text — never the free-text `summary`.
  return preferLimitLabel(
    formatLimitLabelText(event.eventType) ?? dataText,
    matched
  );
}

export function getTurnEventLimitLabel(item: TurnItem): string | null {
  if (item.type !== "event") {
    return null;
  }
  // FEA-3642: `dot: "r"` marks a red-dot turn item, which covers failures as
  // well as limits, so it alone is not a limit signal. Only the structured `tag`
  // (the harness event-type label) may classify a turn item as a limit; the
  // free-text `text` summary is ignored so ordinary prose that mentions rate
  // limits never produces a dot.
  const matched = item.dot === "r" ? firstLimitText([item.tag]) : null;
  if (!matched) {
    return null;
  }
  return preferLimitLabel(item.tag, matched);
}

/** The turn item's ISO timestamp when it carries one. */
export function getTurnItemTimestamp(item: TurnItem): string | null {
  if ("t" in item && typeof item.t === "string") {
    return item.t;
  }
  return null;
}

function firstLimitText(values: readonly (string | null | undefined)[]) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed && LIMIT_SIGNAL_TEXT_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function getLimitDataText(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const values: string[] = [];
  for (const key of LIMIT_DATA_TEXT_KEYS) {
    const field = value[key];
    if (key === "statusCode" && typeof field === "number") {
      values.push(`HTTP ${field}`);
      continue;
    }
    if (typeof field === "string") {
      values.push(field);
      continue;
    }
    if (typeof field === "number") {
      values.push(String(field));
    }
  }
  if (values.length === 0) {
    return null;
  }
  return values.join(" ");
}

function preferLimitLabel(
  preferred: string | null | undefined,
  matched: string
): string {
  const trimmed = preferred?.trim();
  if (trimmed && LIMIT_SIGNAL_TEXT_REGEX.test(trimmed)) {
    return trimmed;
  }
  return matched;
}
