/**
 * @file genai-cost.ts
 * @description Canonical, cross-runtime token-cost engine backed by
 * `@pydantic/genai-prices`. This is the SINGLE source of genai-prices costing
 * shared by `apps/api` (Session re-pricing — FEA-1718 / Q-F) and `apps/desktop`
 * (synced-session costing). It supersedes the former desktop-only ESM twin
 * (`apps/desktop/src/shared/token-cost.ts`), which now re-exports from here.
 *
 * ── Core principle ───────────────────────────────────────────────────────────
 * TRUST THE LIBRARY. genai-prices is the single source of truth for model
 * rates. This module never overrides, clamps, asserts, or rewrites any price it
 * returns. Its only job is to feed correct INPUTS.
 *
 * ── The input-token convention ───────────────────────────────────────────────
 * genai-prices treats `Usage.input_tokens` as the GRAND TOTAL prompt size
 * (uncached + cache_read + cache_write); internally it derives
 *   uncached = input_tokens - cache_read_tokens - cache_write_tokens
 * and throws if that goes negative.
 *
 * Our callers ALWAYS pass the canonical "fresh" shape: `inputTokens` is the
 * UNCACHED token count and `cacheReadTokens`/`cacheWriteTokens` are SEPARATE
 * additive components. This is a hard invariant of every desktop harness parser
 * — see `NormalizedTokenCounts` in
 * `apps/desktop/src/main/collectors/types.ts` (sources that report an inclusive
 * total, e.g. Codex/OpenAI, are normalized to fresh at parse time by subtracting
 * cached). Because the shape is uniform, `buildUsage` ALWAYS sums to reconstruct
 * the genai-prices grand total — there is no per-provider branch. The library
 * then re-derives `uncached = total - cacheRead - cacheWrite = input ≥ 0`.
 */
import {
  calcPrice,
  findProvider,
  type PriceCalculationResult,
} from "@pydantic/genai-prices";

/** One not-priced reason, surfaced so callers can render "—" deliberately. */
export const TokenCostNotPricedReason = {
  UnknownModel: "unknown_model",
  NoMatch: "no_match",
  ComputeError: "compute_error",
  /**
   * A count was negative, non-finite, or inconsistent with the bucket it
   * subdivides — corrupt input we can't price correctly. Covers the four token
   * counts here and, in the parity layer, the harness-only auxiliary counts
   * (web-search requests, the one-hour cache-write subdivision). Surfaced (not
   * thrown, not coerced to a lying $0) so the caller completes with a null
   * "unknown" cost and forwards it to DataDog via the pricing-miss seam.
   */
  InvalidCount: "invalid_count",
} as const;

export type TokenCostNotPricedReason =
  (typeof TokenCostNotPricedReason)[keyof typeof TokenCostNotPricedReason];

export type TokenCostInput = {
  /** Model id as stored in the source DB. */
  model: string;
  /** Provider-native input count (see the input-token convention above). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Optional historical pricing date for timestamped costing. */
  timestamp?: Date;
};

export type TokenCostResult = {
  priced: boolean;
  provider: string | null;
  costUsd: number | null;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheReadCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  /** null when priced; otherwise the not-priced reason. */
  reason: TokenCostNotPricedReason | null;
};

type Counts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * A valid count is finite and non-negative. Exported as the SSOT of "what a
 * trustworthy count looks like" so the parity layer validates its harness-only
 * auxiliary counts (web-search requests, the one-hour cache-write subdivision)
 * against this SAME predicate instead of coercing them privately (ISS-4730).
 */
export function isValidTokenCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * True when every token count on the input is finite and non-negative. A
 * negative or non-finite count is corrupt input — a parser bug or a bad row —
 * and the engine refuses to price it (returning a null "unknown" cost) rather
 * than silently coerce it to zero and emit a quietly-wrong cost.
 *
 * Exported as the SSOT so parity/wrapper layers (`harness-cost-parity`) gate a
 * bad row through this SAME check instead of coercing it privately — otherwise
 * a path that prices without calling {@link computeTokenCost} (e.g. the fast
 * tier) would silently price garbage (ISS-4730).
 */
export function areTokenCountsValid(input: TokenCostInput): boolean {
  return (
    isValidTokenCount(input.inputTokens) &&
    isValidTokenCount(input.outputTokens) &&
    isValidTokenCount(input.cacheReadTokens) &&
    isValidTokenCount(input.cacheWriteTokens)
  );
}

function notPriced(
  reason: TokenCostNotPricedReason,
  provider: string | null = null
): TokenCostResult {
  return {
    priced: false,
    provider,
    costUsd: null,
    inputCostUsd: null,
    outputCostUsd: null,
    cacheReadCostUsd: null,
    cacheWriteCostUsd: null,
    reason,
  };
}

/**
 * Resolve the provider id for a model id, defensively (findProvider can throw
 * on malformed input). Returns null when the model is unknown.
 */
function resolveProviderId(model: string): string | null {
  try {
    const provider = findProvider({ modelId: model });
    return provider ? provider.id : null;
  } catch {
    return null;
  }
}

/**
 * Build the canonical genai-prices `Usage` from per-harness counts.
 *
 * Counts are ALWAYS in the fresh shape (`input` = uncached, cache fields
 * separate — see the file header), so we ALWAYS sum to reconstruct the
 * genai-prices grand-total `input_tokens`. There is no per-provider branch:
 * passing through a fresh `input` would make the library compute a negative
 * `uncached` whenever cache exceeds the uncached remainder (the FEA-2082
 * `compute_error`).
 */
export function buildUsage(counts: Counts): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
} {
  return {
    input_tokens: counts.input + counts.cacheRead + counts.cacheWrite,
    output_tokens: counts.output,
    cache_read_tokens: counts.cacheRead,
    cache_write_tokens: counts.cacheWrite,
  };
}

type CacheCostSplit = {
  inputCostUsd: number;
  cacheReadCostUsd: number | null;
  cacheWriteCostUsd: number | null;
};

/**
 * Split the library's single `input_price` into uncached-input, cache-read, and
 * cache-write costs by re-pricing with each PRESENT cache component zeroed and
 * diffing (FEA-2344). With no cache tokens it makes no extra `calcPrice` call and
 * returns the whole input as uncached. If a re-price throws, fall the whole input
 * cost back to `input_price` and null the split rather than fail the row.
 */
function isolateCacheCosts(
  fullResult: NonNullable<PriceCalculationResult>,
  counts: Counts,
  model: string,
  options: { timestamp: Date } | undefined
): CacheCostSplit {
  try {
    // Cost attributable to one cache component = full input price minus the
    // price with that component zeroed. Zero when absent (no re-price needed).
    const costOf = (zeroed: Partial<Counts>): number => {
      const without = calcPrice(
        buildUsage({ ...counts, ...zeroed }),
        model,
        options
      );
      return without
        ? Math.max(0, fullResult.input_price - without.input_price)
        : 0;
    };
    const cacheReadCostUsd =
      counts.cacheRead > 0 ? costOf({ cacheRead: 0 }) : 0;
    const cacheWriteCostUsd =
      counts.cacheWrite > 0 ? costOf({ cacheWrite: 0 }) : 0;
    return {
      inputCostUsd: Math.max(
        0,
        fullResult.input_price - cacheReadCostUsd - cacheWriteCostUsd
      ),
      cacheReadCostUsd,
      cacheWriteCostUsd,
    };
  } catch {
    return {
      inputCostUsd: fullResult.input_price,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
    };
  }
}

/**
 * Compute the USD cost for one (model, token-counts) row. Library values are
 * returned UNCHANGED (no rounding/clamping). When not priced, `reason` is one
 * of "unknown_model" | "no_match" | "compute_error" | "invalid_count". Never
 * throws — a caller in a hot render or a batch loop can rely on a result.
 */
export function computeTokenCost(input: TokenCostInput): TokenCostResult {
  const model = typeof input.model === "string" ? input.model : "";
  if (model.length === 0) {
    return notPriced(TokenCostNotPricedReason.UnknownModel);
  }

  const providerId = resolveProviderId(model);

  if (!areTokenCountsValid(input)) {
    // Corrupt counts (negative / non-finite) can't yield a correct cost. Refuse
    // with a typed reason and a null "unknown" cost — never a lying $0 — so the
    // caller completes (drops the row / renders "—") rather than pricing garbage.
    return notPriced(TokenCostNotPricedReason.InvalidCount, providerId);
  }

  const counts: Counts = {
    input: input.inputTokens,
    output: input.outputTokens,
    cacheRead: input.cacheReadTokens,
    cacheWrite: input.cacheWriteTokens,
  };

  const usage = buildUsage(counts);
  const options =
    input.timestamp instanceof Date
      ? { timestamp: input.timestamp }
      : undefined;

  let result: PriceCalculationResult;
  try {
    result = calcPrice(usage, model, options);
  } catch {
    // calcPrice throws on genuinely inconsistent input (e.g. negative uncached).
    // Never crash the cost path — surface as not-priced so the caller can show
    // "—" rather than a wrong number or an exception.
    return notPriced(TokenCostNotPricedReason.ComputeError, providerId);
  }

  if (!result) {
    // Library found no matching model/provider → not priced.
    return notPriced(TokenCostNotPricedReason.NoMatch, providerId);
  }

  const cacheSplit = isolateCacheCosts(result, counts, model, options);

  return {
    priced: true,
    provider: result.provider?.id ?? providerId,
    costUsd: result.total_price,
    inputCostUsd: cacheSplit.inputCostUsd,
    outputCostUsd: result.output_price,
    cacheReadCostUsd: cacheSplit.cacheReadCostUsd,
    cacheWriteCostUsd: cacheSplit.cacheWriteCostUsd,
    reason: null,
  };
}

/**
 * Build a not-priced {@link TokenCostResult} for `model`, with the same null
 * shape and provider provenance {@link computeTokenCost} produces when it
 * refuses a row. Exported so a wrapper layer (`harness-cost-parity`) can refuse
 * a corrupt row through this SAME constructor rather than hand-rolling a null
 * result that could drift from the invariant `!priced ⇒ every cost is null`.
 */
export function notPricedTokenCost(
  reason: TokenCostNotPricedReason,
  model: string
): TokenCostResult {
  return notPriced(reason, resolveProviderId(model));
}
