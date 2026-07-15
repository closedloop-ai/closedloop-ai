/**
 * Agent-component analytics DTOs — token-trend time series (AC-018).
 *
 * Shared response shapes for:
 *   GET /agent-components/{slug}/token-trend
 *
 * The ranking and compliance DTOs live in `packages/api/src/types/analytics.ts`
 * (already established by the ranking/compliance services). This file extends
 * that module with the per-(component, model) token-trend time-series types.
 *
 * Types follow the repo-sanctioned `as const` + `(typeof X)[keyof typeof X]`
 * pattern; no TypeScript `enum`. Kept in `packages/api/src/types/` because
 * they are consumed by BOTH the web surface (`apps/app`) and the API server.
 *
 * @repo/api MUST NOT import from @repo/app or apps/*.
 */

// ---------------------------------------------------------------------------
// Token trend
// ---------------------------------------------------------------------------

/**
 * A single time-series data point for token/cost/latency/truncation metrics
 * per (component, model).
 *
 * Grain: one point per (AgentComponentSessionUsage row × AgentSessionTokenUsage
 * model row). Token values are scoped to the model within the session.
 */
export type TokenTrendPoint = {
  /** Session artifact id (the time-series grain is per session × model). */
  sessionId: string;
  /** ISO timestamp when the session started. */
  sessionStartedAt: string;
  /** AI model name (e.g. "claude-opus-4-5"). */
  model: string;
  /** Total input tokens for this (session, model) pair. */
  inputTokens: number;
  /** Total output tokens for this (session, model) pair. */
  outputTokens: number;
  /** Cache-read tokens. */
  cacheReadTokens: number;
  /** Cache-write tokens. */
  cacheWriteTokens: number;
  /** Estimated cost in USD for this (session, model) pair. */
  estimatedCostUsd: number;
  /**
   * Session wall-clock runtime in milliseconds (latency proxy).
   * Sourced from `AgentSessionUsageRollup.runtimeMs` when available;
   * falls back to `sessionEndedAt - sessionStartedAt`. null when neither
   * source is available.
   */
  runtimeMs: number | null;
  /**
   * Number of invocations of the component in this session (from
   * AgentComponentSessionUsage.invocationCount).
   */
  componentInvocations: number;
  /**
   * Number of component-level errors in this session (from
   * AgentComponentSessionUsage.errorCount). Used as a truncation/failure proxy.
   */
  componentErrorCount: number;
};

/**
 * Response envelope for GET /agent-components/{slug}/token-trend.
 */
export type TokenTrendResponse = {
  /**
   * The org-level identity slug of the component.
   * Format: `${componentKind}::${normalizedKey}`
   */
  slug: string;
  /**
   * Time-series data points, one per (session × model) pair that has both
   * AgentComponentSessionUsage and AgentSessionTokenUsage rows.
   * Ordered ascending by `sessionStartedAt`.
   */
  points: TokenTrendPoint[];
  /**
   * Deduplicated, sorted list of distinct models observed across all points.
   * Convenience for frontends building a model legend.
   */
  models: string[];
};

// ---------------------------------------------------------------------------
// Org-identity slug codec (SSOT)
// ---------------------------------------------------------------------------

/**
 * The org-level component identity slug is a cross-surface CONTRACT: desktop
 * (`apps/desktop`) and cloud (`apps/api`) must encode/decode it identically or
 * component identities silently mismatch between the two surfaces. This module
 * is the single source of truth for that codec — a pure-string leaf with no
 * imports, so it is safe to consume from the desktop main process (a runtime
 * value import here does not pull `@repo/api`'s server-only closure into the
 * pglite boot path — cf. #1618/#1620).
 */

/**
 * Normalize a component key the way the org-identity slug does: prefer
 * `componentKey`, fall back to `name`, lowercase + trim for dedup.
 */
export function normalizeComponentKey(
  componentKey: string | null | undefined,
  name?: string | null
): string {
  return (componentKey ?? name ?? "").toLowerCase().trim();
}

/**
 * Encode a component's org-level identity slug: `${kind}::${normalizedKey}`
 * where `normalizedKey = (componentKey ?? name ?? "").toLowerCase().trim()`.
 */
export function encodeComponentSlug(
  kind: string,
  componentKey: string | null | undefined,
  name?: string | null
): string {
  return `${kind}::${normalizeComponentKey(componentKey, name)}`;
}

/**
 * Decode a `${kind}::${key}` slug back into its parts. Returns `null` when the
 * slug has no `::` separator (invalid format).
 */
export function decodeComponentSlug(
  slug: string
): { kind: string; key: string } | null {
  const sep = slug.indexOf("::");
  if (sep === -1) {
    return null;
  }
  return { kind: slug.slice(0, sep), key: slug.slice(sep + 2) };
}
