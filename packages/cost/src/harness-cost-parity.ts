/**
 * @file harness-cost-parity.ts
 * @description Claude-Code cost PARITY layer over the canonical genai-prices
 * engine (`genai-cost.ts`). It closes the two structural gaps between our
 * transcript-derived cost and Claude Code's own `/cost` total, WITHOUT touching
 * `genai-cost.ts` (which is contractually "trust the library — never override a
 * price"). Both gaps are things genai-prices legitimately does not model:
 *
 * 1. **Web-search requests.** Claude Code's `tokensToUSDCost`
 *    (`src/utils/modelCost.ts`) adds `web_search_requests × $0.01`
 *    ($10 / 1000 requests). genai-prices prices tokens only, so we add this as
 *    an explicit component on top — never a token-rate override.
 * 2. **Fast-mode Opus 4.6.** Claude Code prices Opus 4.6 at a 6× "fast" tier
 *    when `usage.speed === 'fast'` (`getOpus46CostTier` →
 *    `COST_TIER_30_150` vs the standard `COST_TIER_5_25`). genai-prices has no
 *    fast-mode concept and prices Opus 4.6 at the standard tier, so for fast
 *    turns we recompute the token portion at Claude Code's fast tier.
 *
 * 3. **Unknown-model fallback (FEA-3546).** genai-prices legitimately returns
 *    "no match" for models it hasn't ingested yet (e.g. a freshly-shipped
 *    `gpt-5.6-sol` Codex model), which collapses a heavily-used session's cost
 *    to $0/null. Claude Code NEVER shows $0 for an unknown model: its
 *    `getModelCosts` (`src/utils/modelCost.ts`) falls back to
 *    `DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25` (current-gen Opus standard)
 *    and flags "costs may be inaccurate". We reproduce that here — when the
 *    library can't price a model, we price it at the deterministic Opus-standard
 *    tier and return `priced: true` (with `reason: null`), never a wrong-shape
 *    `null`. This is the parity floor; it deliberately lives in this layer and
 *    NOT in {@link computeTokenCost}, which is contractually "trust the library"
 *    (it must keep surfacing a typed not-priced reason so observability can
 *    report the miss).
 *
 * 4. **Cache-write TTL premium (FEA-3419).** Anthropic bills prompt-cache
 *    writes by TTL: a five-minute ephemeral write costs 1.25× the base input
 *    rate, a one-hour write costs 2× (Anthropic prompt-caching pricing).
 *    genai-prices exposes a single `cache_write_mtok` rate — it prices EVERY
 *    cache-write token at the five-minute (1.25×) rate and has no TTL dimension.
 *    So a session whose writes were actually one-hour writes is under-priced
 *    (the FEA-3419 evidence session: 90,091 one-hour tokens priced at $12.50/M
 *    instead of $20/M). When a caller supplies the per-call one-hour token count
 *    ({@link HarnessCostInput.cacheWrite1hTokens}), we add the missing premium on
 *    top of the library's cache-write cost: the one-hour portion should cost
 *    2×/1.25× = 1.6× what the library charged it, i.e. an extra
 *    (2.0 − 1.25)/1.25 = 0.6× of the library's per-token cache-write cost for
 *    those tokens. The premium rate is recovered from whichever cache-write
 *    cost priced the row — the library's own price, or (for the fast/unknown-
 *    model tiers) their pre-existing hardcoded flat rate — never a NEW hardcoded
 *    rate introduced by this premium logic, so this stays a "trust the priced
 *    row" TTL correction the library can't express, applied per call.
 *    Five-minute writes are already correct at the library's 1.25× rate and get
 *    no adjustment; an unreported/`absent` split supplies no one-hour count and
 *    is therefore unchanged, priced entirely at the five-minute rate.
 *
 * Callers that pass none of `webSearchRequests` / `fast` / `cacheWrite1hTokens`,
 * and whose model the library CAN price, get results byte-identical to
 * {@link computeTokenCost} — this is a purely additive, opt-in layer.
 */
import {
  areTokenCountsValid,
  computeTokenCost,
  isValidTokenCount,
  TokenCostNotPricedReason as NotPricedReason,
  notPricedTokenCost,
  type TokenCostInput,
  type TokenCostNotPricedReason,
  type TokenCostResult,
} from "./genai-cost";

/** Claude Code web-search price: $10 / 1000 requests = $0.01 / request. */
export const WEB_SEARCH_COST_PER_REQUEST_USD = 0.01;

/**
 * Anthropic prompt-cache write multipliers, relative to the base input token
 * rate (Anthropic prompt-caching pricing):
 *  - five-minute ephemeral write: 1.25× base input
 *  - one-hour ephemeral write:    2.00× base input
 * genai-prices bakes the 1.25× (five-minute) rate into `cache_write_mtok`, so
 * only the one-hour DELTA over that rate is added on top.
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
/**
 * Extra fraction of the LIBRARY-charged per-token cache-write cost owed for a
 * one-hour write: `(2.0 − 1.25) / 1.25 = 0.6`. Multiply by the library's
 * per-token cache-write cost and the one-hour token count to get the premium.
 */
export const CACHE_WRITE_1H_PREMIUM_OVER_5M =
  (CACHE_WRITE_1H_MULTIPLIER - CACHE_WRITE_5M_MULTIPLIER) /
  CACHE_WRITE_5M_MULTIPLIER;

/**
 * Claude Code's Opus 4.6 per-million-token rates (`src/utils/modelCost.ts`).
 * Standard = `COST_TIER_5_25`; fast = `COST_TIER_30_150` (6× across the board).
 * genai-prices already applies the standard tier (verified: `claude-opus-4-5`
 * prices at 5/25/6.25/0.5), so only the fast tier is recomputed here.
 */
const OPUS_46_FAST_TIER = {
  input: 30,
  output: 150,
  cacheWrite: 37.5,
  cacheRead: 3,
} as const;

/**
 * Claude Code's `DEFAULT_UNKNOWN_MODEL_COST` (`src/utils/modelCost.ts`) —
 * `COST_TIER_5_25`, current-generation Opus standard. Used as the deterministic
 * floor when genai-prices can't price a model at all (FEA-3546), so a
 * heavily-used session never reports $0/null just because its model id is newer
 * than the library's ingested price table.
 */
const UNKNOWN_MODEL_FALLBACK_TIER = {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
} as const;

/** Matches Claude Opus 4.6 model ids (`claude-opus-4-6`, `claude-opus-4.6`, …). */
const OPUS_46_PATTERN = /opus-4[.\-_]?6/i;

/** True when the model id is a Claude Opus 4.6 variant (fast tier applies). */
export function isOpus46(model: string): boolean {
  return OPUS_46_PATTERN.test(model);
}

export type HarnessCostInput = TokenCostInput & {
  /** `usage.server_tool_use.web_search_requests` for the row (default 0). */
  webSearchRequests?: number;
  /** True when the turn ran in fast mode (`usage.speed === 'fast'`). */
  fast?: boolean;
  /**
   * FEA-3419: how many of this row's `cacheWriteTokens` were ONE-HOUR ephemeral
   * writes (`cache_creation.ephemeral_1h_input_tokens`). A subdivision of
   * `cacheWriteTokens`, never additive to it. Defaults to 0 — meaning either an
   * all-five-minute row or an unreported/`absent` split, both of which price
   * entirely at the library's five-minute cache-write rate (no change). A
   * malformed breakdown — negative, non-finite, or larger than the
   * `cacheWriteTokens` bucket it subdivides — is REFUSED as `invalid_count`
   * (ISS-4730), not clamped: clamping would quietly price a corrupt row at a
   * fabricated TTL mix. This mirrors the sync ingest boundary, which already
   * rejects a subdivision exceeding `cacheWriteTokens`
   * (`apps/api/lib/desktop-agent-sessions-schema.ts`).
   */
  cacheWrite1hTokens?: number;
};

export type HarnessCostResult = TokenCostResult & {
  /** The web-search component added on top of the token cost. */
  webSearchCostUsd: number;
  /** True when Claude Code's fast-mode Opus 4.6 tier was applied. */
  fastModeApplied: boolean;
  /**
   * FEA-3419: the one-hour cache-write TTL premium added on top of the library's
   * (five-minute-rate) cache-write cost. Zero when no one-hour tokens were
   * supplied, when the row has no cache writes, or when the final result is not
   * priced at all (`unknown_model`/`compute_error`, where it is explicitly 0 —
   * see the not-priced branch below). Note the unknown-model fallback tier
   * (FEA-3546) still prices the premium: a `no_match` model is fallback-priced,
   * so its premium can be non-zero. Already included in `costUsd` and
   * `cacheWriteCostUsd`; exposed so callers / observability can attribute the
   * correction.
   */
  cacheWriteTtlPremiumUsd: number;
  /**
   * True only when the Opus-standard unknown-model fallback (FEA-3546) supplied
   * the price because genai-prices could not (mirrors `fastModeApplied`). Lets
   * callers/observability distinguish a deterministic guessed price from a
   * library-confirmed one — a fallback figure is a parity floor, not a verified
   * rate.
   */
  unknownModelFallbackApplied: boolean;
};

/**
 * True when this row's harness-only auxiliary counts are trustworthy: the
 * web-search request count is finite and non-negative, and the one-hour
 * cache-write subdivision is finite, non-negative, and no larger than the
 * `cacheWriteTokens` bucket it subdivides.
 *
 * These counts get the SAME treatment as the token counts (ISS-4730): corrupt
 * ones are refused, never coerced. Coercing a garbage web-search count to 0
 * would price the row as though the harness ran no searches, and clamping a
 * malformed one-hour count would price it at a fabricated TTL mix — both are
 * exactly the quietly-wrong number `invalid_count` exists to prevent.
 */
function areHarnessAuxCountsValid(input: HarnessCostInput): boolean {
  const oneHour = input.cacheWrite1hTokens ?? 0;
  return (
    isValidTokenCount(input.webSearchRequests ?? 0) &&
    isValidTokenCount(oneHour) &&
    oneHour <= input.cacheWriteTokens
  );
}

type Tier = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

/**
 * Price a row directly from a flat per-million-token `Tier`, independent of
 * genai-prices. Cache tokens are additive components (fresh shape), matching the
 * engine's convention. Used for both the Opus 4.6 fast tier and the
 * unknown-model fallback tier.
 *
 * PRECONDITION: the counts MUST already be validated (`areTokenCountsValid`).
 * Every call site is gated on `countsValid` in {@link computeHarnessCost}, so
 * this prices the counts as given and deliberately does NOT coerce a corrupt
 * count to 0 — that would resurrect the lying $0 the engine's `invalid_count`
 * refusal removed (ISS-4730).
 */
function tierTokenCost(
  input: TokenCostInput,
  tier: Tier
): {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
} {
  const inputCostUsd = (input.inputTokens / 1e6) * tier.input;
  const outputCostUsd = (input.outputTokens / 1e6) * tier.output;
  const cacheReadCostUsd = (input.cacheReadTokens / 1e6) * tier.cacheRead;
  const cacheWriteCostUsd = (input.cacheWriteTokens / 1e6) * tier.cacheWrite;
  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    costUsd:
      inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
  };
}

/**
 * FEA-3419: the one-hour cache-write TTL premium for a row.
 *
 * `cacheWriteCostUsd` is the FULL cache-write cost as charged at the library's
 * (or a flat tier's) five-minute 1.25× rate for ALL `cacheWriteTokens`. The
 * one-hour portion should have been charged at 2×, i.e. 1.6× that per-token
 * cost — an extra {@link CACHE_WRITE_1H_PREMIUM_OVER_5M} (0.6×) for those
 * tokens. We derive the per-token five-minute cost from `cacheWriteCostUsd /
 * cacheWriteTokens` (data-driven — never a hardcoded per-model rate) and scale
 * it by the one-hour token count.
 *
 * Returns 0 when there are no cache writes, no one-hour tokens, or the row's
 * cache-write cost is unknown/zero — the safe no-op that leaves the existing
 * (correct) five-minute pricing untouched.
 *
 * PRECONDITION: the counts MUST already be validated (`areTokenCountsValid` +
 * {@link areHarnessAuxCountsValid}), so `cacheWriteTokens` is finite and
 * non-negative and the one-hour count lies within it. Nothing is coerced or
 * clamped here — a corrupt row is refused upstream in
 * {@link computeHarnessCost}, never quietly repaired into a price (ISS-4730).
 */
function cacheWriteTtlPremium(
  cacheWriteCostUsd: number | null,
  cacheWriteTokens: number,
  cacheWrite1hTokens: number | undefined
): number {
  const oneHour = cacheWrite1hTokens ?? 0;
  if (
    cacheWriteCostUsd === null ||
    !Number.isFinite(cacheWriteCostUsd) ||
    cacheWriteCostUsd <= 0 ||
    cacheWriteTokens <= 0 ||
    oneHour <= 0
  ) {
    return 0;
  }
  const perTokenFiveMinuteCost = cacheWriteCostUsd / cacheWriteTokens;
  return oneHour * perTokenFiveMinuteCost * CACHE_WRITE_1H_PREMIUM_OVER_5M;
}

/**
 * The not-priced reasons that mean "the library simply has no price entry for
 * this (recognized-shape) model" — i.e. a newer-than-the-table model — as
 * opposed to a data defect. Only these get the Opus-standard fallback:
 *  - `no_match`: a non-empty model id the library couldn't map to any price.
 *  - `unknown_model` is EXCLUDED: it's an empty model id (a data defect), not a
 *    newer model, so there is nothing meaningful to price at a fallback tier.
 *  - `compute_error` is EXCLUDED: inconsistent counts (e.g. negative uncached);
 *    a fabricated fallback cost would be built on meaningless inputs.
 */
function isUnknownModelFallbackReason(
  reason: TokenCostNotPricedReason | null
): boolean {
  return reason === NotPricedReason.NoMatch;
}

/**
 * Assemble a priced {@link HarnessCostResult} from a flat {@link Tier} — the
 * shared shaping for the two flat-tier branches (Opus 4.6 fast and the
 * unknown-model fallback), which are identical apart from `provenance`. Adds the
 * web-search component and folds the one-hour cache-write TTL premium into both
 * `costUsd` and `cacheWriteCostUsd`. Its {@link tierTokenCost} call trusts
 * validated counts, so every caller gates on `countsValid` first (ISS-4730).
 */
function pricedFromTier(
  input: HarnessCostInput,
  tier: Tier,
  provenance: {
    provider: string | null;
    webSearchCostUsd: number;
    fastModeApplied: boolean;
    unknownModelFallbackApplied: boolean;
  }
): HarnessCostResult {
  const cost = tierTokenCost(input, tier);
  const cacheWriteTtlPremiumUsd = cacheWriteTtlPremium(
    cost.cacheWriteCostUsd,
    input.cacheWriteTokens,
    input.cacheWrite1hTokens
  );
  return {
    priced: true,
    provider: provenance.provider,
    costUsd:
      cost.costUsd + provenance.webSearchCostUsd + cacheWriteTtlPremiumUsd,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    cacheReadCostUsd: cost.cacheReadCostUsd,
    cacheWriteCostUsd: cost.cacheWriteCostUsd + cacheWriteTtlPremiumUsd,
    reason: null,
    webSearchCostUsd: provenance.webSearchCostUsd,
    fastModeApplied: provenance.fastModeApplied,
    cacheWriteTtlPremiumUsd,
    unknownModelFallbackApplied: provenance.unknownModelFallbackApplied,
  };
}

/**
 * Compute a Claude-Code-parity cost for one (model, counts) row: the canonical
 * genai-prices token cost, plus the web-search component, with the Opus 4.6
 * fast-mode tier substituted for the token portion on fast turns.
 */
export function computeHarnessCost(input: HarnessCostInput): HarnessCostResult {
  const webSearchRequests = input.webSearchRequests ?? 0;
  // The web-search component is reported only when its own count is sound. A 0
  // derived from a garbage count would be the same lie in a different field.
  const webSearchCostUsd = isValidTokenCount(webSearchRequests)
    ? webSearchRequests * WEB_SEARCH_COST_PER_REQUEST_USD
    : 0;

  // ISS-4730, extended to the harness-only auxiliary counts: a corrupt
  // web-search or one-hour cache-write count is refused outright, exactly like a
  // corrupt token count. Zeroing/clamping it would still return `priced: true`
  // with a confident dollar figure computed from data we know is wrong.
  // Deliberately checked ahead of the model id (where the engine checks the
  // model first): a corrupt count is a producer defect worth surfacing as
  // `invalid_count` even on a row whose model is ALSO unpriceable.
  if (!areHarnessAuxCountsValid(input)) {
    return {
      ...notPricedTokenCost(NotPricedReason.InvalidCount, input.model),
      webSearchCostUsd,
      fastModeApplied: false,
      cacheWriteTtlPremiumUsd: 0,
      unknownModelFallbackApplied: false,
    };
  }

  // Reconcile with the engine (ISS-4730): a corrupt token count is never priced
  // from a flat tier — not the fast tier, not the unknown-model fallback. Both
  // tier paths below are gated on this flag, so `tierTokenCost` always receives
  // validated counts and prices them as-is (no coercion). A corrupt row falls
  // through to `computeTokenCost`, which returns `invalid_count` — not a
  // fallback reason, so it stays refused with a null cost rather than lying $0.
  const countsValid = areTokenCountsValid(input);

  // Fast-mode Opus 4.6: genai-prices has no fast tier, so compute the token
  // portion directly from Claude Code's fast tier (independent of whether
  // genai-prices knows the model at all).
  const applyFast = input.fast === true && isOpus46(input.model) && countsValid;
  if (applyFast) {
    return pricedFromTier(input, OPUS_46_FAST_TIER, {
      provider: "anthropic",
      webSearchCostUsd,
      fastModeApplied: true,
      unknownModelFallbackApplied: false,
    });
  }

  const base = computeTokenCost(input);

  // Not priced by the library (unknown/newer model): apply the Opus-standard
  // unknown-model fallback (FEA-3546) so a heavily-used session is never $0/null.
  // This mirrors Claude Code's `DEFAULT_UNKNOWN_MODEL_COST` and is the whole
  // reason this parity layer exists — `computeTokenCost` deliberately keeps
  // surfacing the typed not-priced reason (for observability); we recover a
  // priced figure here. We do NOT fall back on `unknown_model` (empty model id)
  // or `compute_error` (genuinely inconsistent counts) — only on the "library
  // has no price entry" reasons — because an empty model or negative-uncached
  // row is a data defect, not a newer-than-the-table model, and pricing it would
  // fabricate a cost from meaningless inputs.
  if (!base.priced || base.costUsd === null) {
    if (countsValid && isUnknownModelFallbackReason(base.reason)) {
      return pricedFromTier(input, UNKNOWN_MODEL_FALLBACK_TIER, {
        provider: base.provider,
        webSearchCostUsd,
        fastModeApplied: false,
        unknownModelFallbackApplied: true,
      });
    }
    // `unknown_model` / `compute_error` / `invalid_count`: preserve the
    // `TokenCostResult` invariant that `!priced` ⇒ `costUsd === null`. Callers
    // gate on `result.priced` before summing, so overloading `costUsd` with
    // web-search-only spend here would be silently dropped anyway while breaking
    // that contract. The web-search component stays exposed on
    // `webSearchCostUsd` for any caller that chooses to account for it.
    return {
      ...base,
      webSearchCostUsd,
      fastModeApplied: false,
      cacheWriteTtlPremiumUsd: 0,
      unknownModelFallbackApplied: false,
    };
  }

  // Library priced the row (cache writes at its five-minute 1.25× rate). Add the
  // one-hour TTL premium for any one-hour portion of those cache writes.
  const cacheWriteTtlPremiumUsd = cacheWriteTtlPremium(
    base.cacheWriteCostUsd,
    input.cacheWriteTokens,
    input.cacheWrite1hTokens
  );
  return {
    ...base,
    costUsd: base.costUsd + webSearchCostUsd + cacheWriteTtlPremiumUsd,
    cacheWriteCostUsd:
      base.cacheWriteCostUsd === null
        ? base.cacheWriteCostUsd
        : base.cacheWriteCostUsd + cacheWriteTtlPremiumUsd,
    webSearchCostUsd,
    fastModeApplied: false,
    cacheWriteTtlPremiumUsd,
    unknownModelFallbackApplied: false,
  };
}
