import type { SyncedAgentSessionTokenUsage } from "@repo/api/src/types/agent-session";

/**
 * FEA-3419: the ephemeral cache-write TTL split (5-minute vs 1-hour cache-
 * creation tokens) for a session, derived from the typed per-model token
 * usage. A subdivision of the canonical cache-write total — never additive.
 */
export type CacheWriteTtlBreakdown = {
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
};

/**
 * FEA-3419: derive the session-wide cache-write TTL split (5-minute vs 1-hour
 * ephemeral cache-write tokens) from the TYPED per-model token usage — the
 * single source of truth on both surfaces (web reads the cloud
 * `agent_session_token_usage` columns; desktop reads its local `token_usage`
 * columns through the same `SyncedAgentSessionTokenUsage` shape). Replaces the
 * FEA-3528 metadata-blob spelunking: the `usageExtras.cache_creation` blob no
 * longer exists.
 *
 * Returns `null` when NO model reported a breakdown (absent provenance —
 * legacy sessions, non-Claude harnesses, pre-TTL desktop builds) or when the
 * reported split is entirely zero — so callers omit the row rather than render
 * a `0|0` line.
 */
export function deriveCacheWriteTtlBreakdown(
  tokenUsageByModel: readonly SyncedAgentSessionTokenUsage[] | undefined
): CacheWriteTtlBreakdown | null {
  if (!tokenUsageByModel) {
    return null;
  }
  let ephemeral5mInputTokens = 0;
  let ephemeral1hInputTokens = 0;
  let reported = false;
  for (const usage of tokenUsageByModel) {
    if (usage.cacheWrite1hTokens == null && usage.cacheWrite5mTokens == null) {
      continue;
    }
    reported = true;
    ephemeral5mInputTokens += nonNegativeTokenCount(usage.cacheWrite5mTokens);
    ephemeral1hInputTokens += nonNegativeTokenCount(usage.cacheWrite1hTokens);
  }
  if (
    !reported ||
    (ephemeral5mInputTokens === 0 && ephemeral1hInputTokens === 0)
  ) {
    return null;
  }
  return { ephemeral5mInputTokens, ephemeral1hInputTokens };
}

/** Coerce an untrusted wire value to a safe non-negative integer. */
function nonNegativeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
