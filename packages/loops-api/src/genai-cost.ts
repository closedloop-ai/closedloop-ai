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
  /** null when priced; otherwise the not-priced reason. */
  reason: TokenCostNotPricedReason | null;
};

type Counts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Coerce a possibly-null/undefined/string DB token count to a finite number. */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
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

/**
 * Compute the USD cost for one (model, token-counts) row. Library values are
 * returned UNCHANGED (no rounding/clamping). When not priced, `reason` is one
 * of "unknown_model" | "no_match" | "compute_error".
 */
export function computeTokenCost(input: TokenCostInput): TokenCostResult {
  const model = typeof input.model === "string" ? input.model : "";
  if (model.length === 0) {
    return notPriced(TokenCostNotPricedReason.UnknownModel);
  }

  const counts: Counts = {
    input: toCount(input.inputTokens),
    output: toCount(input.outputTokens),
    cacheRead: toCount(input.cacheReadTokens),
    cacheWrite: toCount(input.cacheWriteTokens),
  };

  const providerId = resolveProviderId(model);
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

  return {
    priced: true,
    provider: result.provider?.id ?? providerId,
    costUsd: result.total_price,
    inputCostUsd: result.input_price,
    outputCostUsd: result.output_price,
    reason: null,
  };
}
