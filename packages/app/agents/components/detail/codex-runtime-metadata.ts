import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { asRecord } from "@repo/lib/harness/type-guards";

/**
 * FEA-3703: aggregate per-turn Codex token COUNTS captured from a
 * `token_count.last_token_usage` snapshot. COUNTS ONLY — never any raw reasoning
 * content (Codex `reasoning_output_tokens` is folded into `output` upstream and
 * is a bare integer here). `total` is the derived grand-total prompt+output size
 * (`input + output + cacheRead + cacheWrite`).
 */
export type CodexTokenUsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/**
 * FEA-3703: a single Codex rate-limit window (primary = shortest, secondary =
 * longer) surfaced for display. `usedPercent` is clamped to [0, 100];
 * `windowMinutes` and `resetsAtEpochSeconds` are passed through when well-formed,
 * else null — so an absent field renders an em-dash rather than a lie.
 * `resetsAtEpochSeconds` is the Codex `resets_at` value, an ABSOLUTE Unix
 * epoch-seconds timestamp (FEA-3524) — the same shape the desktop session-limits
 * mappers treat as epoch — NOT a relative seconds-from-now delta. The remaining
 * time is computed against the current clock at render (see
 * `formatCodexRateLimitWindow`).
 */
export type CodexRateLimitWindowView = {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAtEpochSeconds: number | null;
};

/**
 * FEA-3703: the read-time view model for the persisted Codex runtime metadata
 * (FEA-3524 rate limits, FEA-3525 context window, FEA-3526 last-token-usage
 * snapshots). Assembled from the session `metadata` blob, which both the cloud
 * sync and the desktop local read carry through unchanged — so a single selector
 * serves web AND desktop. Every field is independently nullable to preserve the
 * absent / unsupported / malformed distinctions: a Codex session that reported
 * only a context window yields `{ modelContextWindow, latestTokenUsage: null,
 * rateLimits: null }` rather than an all-or-nothing tile.
 */
export type CodexRuntimeMetadata = {
  /** Codex `token_count.info.model_context_window` (tokens), or null. */
  modelContextWindow: number | null;
  /**
   * Aggregate COUNTS from the freshest well-formed `last_token_usage` snapshot
   * (the "last good" sample), or null when none is well-formed.
   */
  latestTokenUsage: CodexTokenUsageCounts | null;
  /**
   * Context-window utilization for the latest snapshot: `latest.total /
   * modelContextWindow`, clamped to [0, 100]. Null unless BOTH a context window
   * and a latest snapshot are present (utilization is undefined otherwise).
   */
  contextWindowUtilizationPercent: number | null;
  /** Latest well-formed rate-limit windows, or null when none was captured. */
  rateLimits: {
    primary: CodexRateLimitWindowView | null;
    secondary: CodexRateLimitWindowView | null;
  } | null;
};

/**
 * FEA-3703: assemble the {@link CodexRuntimeMetadata} view model from the
 * untyped, possibly cloud-synced session metadata blob. Reads defensively — a
 * missing, wrong-typed, or malformed value coerces to null per-field rather than
 * throwing or leaking a bad value. Returns null only when NONE of the three
 * signals is present, so callers omit the tile entirely for non-Codex sessions
 * (and every pre-FEA-3524/3525/3526 payload) rather than rendering an empty box.
 */
export function extractCodexRuntimeMetadata(
  metadata: AgentSessionDetail["metadata"]
): CodexRuntimeMetadata | null {
  const blob = asRecord(metadata);
  if (!blob) {
    return null;
  }
  const modelContextWindow = optionalTokenCount(blob.modelContextWindow);
  const latestTokenUsage = latestCodexTokenCounts(blob.codexLastTokenUsage);
  const rateLimitsBlob = asRecord(blob.codexRateLimits);
  const primary = rateLimitsBlob
    ? readCodexRateLimitWindow(rateLimitsBlob.primary)
    : null;
  const secondary = rateLimitsBlob
    ? readCodexRateLimitWindow(rateLimitsBlob.secondary)
    : null;
  const rateLimits = primary || secondary ? { primary, secondary } : null;

  if (modelContextWindow === null && !latestTokenUsage && !rateLimits) {
    return null;
  }

  const contextWindowUtilizationPercent =
    modelContextWindow && modelContextWindow > 0 && latestTokenUsage
      ? clampPercentValue((latestTokenUsage.total / modelContextWindow) * 100)
      : null;

  return {
    modelContextWindow,
    latestTokenUsage,
    contextWindowUtilizationPercent,
    rateLimits,
  };
}

/** Coerce an untrusted value to a finite non-negative integer, else null. */
function optionalTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** Coerce an untrusted percent to a finite value clamped to [0, 100], else null. */
function optionalPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return clampPercentValue(value);
}

function clampPercentValue(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

/** Coerce an untrusted value to a finite non-negative epoch/number, else null. */
function optionalFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Read the aggregate token COUNTS from one persisted Codex snapshot
 * (`metadata.codexLastTokenUsage[i].lastTokenUsage`). Returns null when the
 * snapshot is malformed or reports no tokens at all (so a zero-only sample never
 * masquerades as a real "last good" reading). COUNTS ONLY — the caller never
 * reads message/reasoning text out of this blob.
 */
function readCodexTokenCounts(entry: unknown): CodexTokenUsageCounts | null {
  const usage = asRecord(asRecord(entry)?.lastTokenUsage);
  if (!usage) {
    return null;
  }
  const input = optionalTokenCount(usage.input) ?? 0;
  const output = optionalTokenCount(usage.output) ?? 0;
  const cacheRead = optionalTokenCount(usage.cacheRead) ?? 0;
  const cacheWrite = optionalTokenCount(usage.cacheWrite) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Pick the freshest well-formed snapshot's counts — the "last good" reading —
 * scanning from the end of the array (parsers append in event order) so a
 * trailing malformed/zero entry falls back to the last real one rather than
 * blanking the tile.
 */
function latestCodexTokenCounts(value: unknown): CodexTokenUsageCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (let index = value.length - 1; index >= 0; index--) {
    const counts = readCodexTokenCounts(value[index]);
    if (counts) {
      return counts;
    }
  }
  return null;
}

/** Map one persisted rate-limit window; null when the block is malformed/absent. */
function readCodexRateLimitWindow(
  value: unknown
): CodexRateLimitWindowView | null {
  const window = asRecord(value);
  if (!window) {
    return null;
  }
  const usedPercent = optionalPercent(window.used_percent);
  const windowMinutes = optionalFiniteNonNegative(window.window_minutes);
  const resetsAtEpochSeconds = optionalFiniteNonNegative(window.resets_at);
  if (
    usedPercent === null &&
    windowMinutes === null &&
    resetsAtEpochSeconds === null
  ) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAtEpochSeconds };
}
