import { describe, expect, it } from "vitest";

import { computeTokenCost, TokenCostNotPricedReason } from "../src/genai-cost";
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_1H_PREMIUM_OVER_5M,
  CACHE_WRITE_5M_MULTIPLIER,
  computeHarnessCost,
  isOpus46,
  WEB_SEARCH_COST_PER_REQUEST_USD,
} from "../src/harness-cost-parity";

/**
 * Oracle: Claude Code's own cost formula, transcribed verbatim from the leaked
 * `src/utils/modelCost.ts` (`tokensToUSDCost` + the rate tables). We reconcile
 * our parity engine against THIS.
 */
const CC_RATES = {
  // COST_TIER_5_25 — Opus 4.5 / 4.6 standard.
  opusStandard: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // COST_TIER_30_150 — Opus 4.6 fast.
  opusFast: { input: 30, output: 150, cacheWrite: 37.5, cacheRead: 3 },
} as const;

type CcUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearchRequests?: number;
};

function ccTokensToUSDCost(
  usage: CcUsage,
  rates: (typeof CC_RATES)[keyof typeof CC_RATES]
): number {
  return (
    (usage.input / 1e6) * rates.input +
    (usage.output / 1e6) * rates.output +
    (usage.cacheRead / 1e6) * rates.cacheRead +
    (usage.cacheWrite / 1e6) * rates.cacheWrite +
    (usage.webSearchRequests ?? 0) * 0.01
  );
}

describe("isOpus46", () => {
  it("matches Opus 4.6 id variants only", () => {
    expect(isOpus46("claude-opus-4-6")).toBe(true);
    expect(isOpus46("claude-opus-4.6")).toBe(true);
    expect(isOpus46("anthropic/claude-opus-4-6-20260101")).toBe(true);
    expect(isOpus46("claude-opus-4-5")).toBe(false);
    expect(isOpus46("claude-sonnet-4-5")).toBe(false);
  });
});

describe("web-search parity", () => {
  it("adds exactly $0.01 per request on top of the token cost", () => {
    const base = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    });
    const withSearch = computeHarnessCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
      webSearchRequests: 4,
    });
    expect(base.priced).toBe(true);
    expect(withSearch.webSearchCostUsd).toBe(
      4 * WEB_SEARCH_COST_PER_REQUEST_USD
    );
    expect(withSearch.costUsd).toBeCloseTo(
      (base.costUsd ?? 0) + 4 * WEB_SEARCH_COST_PER_REQUEST_USD,
      10
    );
  });

  it("reconciles to Claude Code's formula for a Sonnet-class turn with web search", () => {
    const usage = {
      input: 2000,
      output: 500,
      cacheRead: 1000,
      cacheWrite: 400,
      webSearchRequests: 3,
    };
    const ours = computeHarnessCost({
      model: "claude-opus-4-5",
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      webSearchRequests: usage.webSearchRequests,
    });
    const cc = ccTokensToUSDCost(usage, CC_RATES.opusStandard);
    expect(ours.costUsd).toBeCloseTo(cc, 9);
  });

  it("refuses a garbage web-search count as invalid_count (never a coerced $0)", () => {
    // ISS-4730 applies to the harness auxiliary counts too: coercing a corrupt
    // web-search count to 0 would price the row as though the harness ran no
    // searches — a confident number derived from data we know is wrong. Refuse
    // with a null "unknown" cost instead, exactly like a corrupt token count.
    for (const bad of [-5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = computeHarnessCost({
        model: "claude-opus-4-5",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchRequests: bad,
      });
      expect(result.priced).toBe(false);
      expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
      expect(result.costUsd).toBeNull();
      // No fabricated web-search component either — the count it would come
      // from is the corrupt value.
      expect(result.webSearchCostUsd).toBe(0);
      expect(result.unknownModelFallbackApplied).toBe(false);
    }
  });

  it("still refuses a garbage web-search count on the fast tier", () => {
    // The fast tier prices independently of genai-prices, so it needs its own
    // proof that it cannot launder a corrupt auxiliary count into a price.
    const result = computeHarnessCost({
      model: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      fast: true,
      webSearchRequests: Number.NaN,
    });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.costUsd).toBeNull();
    expect(result.fastModeApplied).toBe(false);
  });

  it("prices a zero web-search count normally (the refusal is for corrupt counts only)", () => {
    const result = computeHarnessCost({
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
    });
    expect(result.priced).toBe(true);
    expect(result.webSearchCostUsd).toBe(0);
  });
});

describe("fast-mode Opus 4.6 parity", () => {
  const usage = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 800 };
  const call = (fast: boolean, webSearchRequests = 0) =>
    computeHarnessCost({
      model: "claude-opus-4-6",
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      fast,
      webSearchRequests,
    });

  it("prices fast turns at Claude Code's 30/150 fast tier exactly", () => {
    const fast = call(true);
    expect(fast.fastModeApplied).toBe(true);
    expect(fast.provider).toBe("anthropic");
    expect(fast.unknownModelFallbackApplied).toBe(false);
    expect(fast.costUsd).toBeCloseTo(
      ccTokensToUSDCost(usage, CC_RATES.opusFast),
      12
    );
  });

  it("is 6x the standard tier (the gap our fix closes)", () => {
    const fast = call(true);
    const ccStandard = ccTokensToUSDCost(usage, CC_RATES.opusStandard);
    const ccFast = ccTokensToUSDCost(usage, CC_RATES.opusFast);
    // Every fast rate is 6x its standard rate.
    expect(ccFast).toBeCloseTo(ccStandard * 6, 12);
    expect(fast.costUsd).toBeCloseTo(ccFast, 12);
    // Without the fix, a standard-tier price would drift ~6x low → reconcilation
    // would flag drift. The fix removes that drift.
    expect(fast.costUsd ?? 0).toBeGreaterThan(ccStandard * 5);
  });

  it("does not apply the fast tier to non-Opus-4.6 models", () => {
    const notOpus46 = computeHarnessCost({
      model: "claude-opus-4-5",
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      fast: true,
    });
    expect(notOpus46.fastModeApplied).toBe(false);
  });

  it("does not apply the fast tier to a non-fast Opus 4.6 turn", () => {
    // The fast tier is gated on `fast === true`, not on the model alone. A
    // non-fast Opus 4.6 turn must price at the standard tier (~1/6 of fast),
    // never the 6x fast tier.
    const standard = call(false);
    expect(standard.fastModeApplied).toBe(false);
    expect(standard.costUsd).toBeCloseTo(
      ccTokensToUSDCost(usage, CC_RATES.opusStandard),
      12
    );
    expect(standard.costUsd ?? 0).toBeLessThan((call(true).costUsd ?? 0) / 5);
  });

  it("adds web search on top of the fast tier", () => {
    const fast = call(true, 2);
    const ccFast = ccTokensToUSDCost(
      { ...usage, webSearchRequests: 2 },
      CC_RATES.opusFast
    );
    expect(fast.webSearchCostUsd).toBe(0.02);
    expect(fast.costUsd).toBeCloseTo(ccFast, 12);
  });
});

describe("unknown-model fallback (FEA-3546)", () => {
  // Opus-standard fallback tier, matching Claude Code's
  // DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25 — the same rate table the parity
  // oracle already declares, so we reuse it rather than redeclare the literals.
  const FALLBACK = CC_RATES.opusStandard;

  it("prices a newer-than-the-table model at the Opus-standard tier (never $0)", () => {
    // gpt-5.6-sol is the model from SES-57401: genai-prices resolves the openai
    // provider but has no price entry (no_match) → previously collapsed to $0.
    const input = {
      model: "gpt-5.6-sol",
      inputTokens: 346_789,
      outputTokens: 12_366,
      cacheReadTokens: 2_560_256,
      cacheWriteTokens: 0,
    };
    const base = computeTokenCost(input);
    // Precondition: the library cannot price this model.
    expect(base.priced).toBe(false);
    expect(base.costUsd).toBeNull();
    expect(base.reason).toBe(TokenCostNotPricedReason.NoMatch);

    const parity = computeHarnessCost(input);
    const expected = ccTokensToUSDCost(
      {
        input: input.inputTokens,
        output: input.outputTokens,
        cacheRead: input.cacheReadTokens,
        cacheWrite: input.cacheWriteTokens,
      },
      FALLBACK
    );
    expect(parity.priced).toBe(true);
    expect(parity.reason).toBeNull();
    expect(parity.costUsd).toBeCloseTo(expected, 12);
    // Heavy usage ⇒ a real, non-trivial dollar figure, not $0.
    expect(parity.costUsd ?? 0).toBeGreaterThan(0);
    expect(parity.fastModeApplied).toBe(false);
    // The guessed price is flagged so observability can tell it apart from a
    // library-confirmed one.
    expect(parity.unknownModelFallbackApplied).toBe(true);
  });

  it("falls back for a model with no provider at all, and adds web search on top", () => {
    const input = {
      model: "totally-unknown-model-xyz",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 5,
    };
    const base = computeTokenCost(input);
    expect(base.priced).toBe(false);
    expect(base.reason).toBe(TokenCostNotPricedReason.NoMatch);

    const parity = computeHarnessCost(input);
    const tokenCost = ccTokensToUSDCost(
      { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      FALLBACK
    );
    const webSearch = 5 * WEB_SEARCH_COST_PER_REQUEST_USD;
    expect(parity.priced).toBe(true);
    expect(parity.webSearchCostUsd).toBe(webSearch);
    expect(parity.costUsd).toBeCloseTo(tokenCost + webSearch, 12);
    expect(parity.unknownModelFallbackApplied).toBe(true);
  });

  it("does NOT fabricate a cost for an empty model id (unknown_model stays null)", () => {
    // An empty model is a data defect, not a newer model — the fallback must not
    // invent a price from a meaningless id.
    const input = {
      model: "",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 3,
    };
    const base = computeTokenCost(input);
    expect(base.reason).toBe(TokenCostNotPricedReason.UnknownModel);

    const parity = computeHarnessCost(input);
    expect(parity.priced).toBe(false);
    expect(parity.costUsd).toBeNull();
    // Web-search component still exposed for deliberate accounting.
    expect(parity.webSearchCostUsd).toBe(3 * WEB_SEARCH_COST_PER_REQUEST_USD);
    expect(parity.fastModeApplied).toBe(false);
    // A data-defect (empty) model is NOT the fallback path — no guessed price.
    expect(parity.unknownModelFallbackApplied).toBe(false);
  });
});

describe("additivity: no extras ⇒ identical to computeTokenCost", () => {
  it("returns the base cost unchanged when no web search and not fast", () => {
    const input = {
      model: "claude-opus-4-5",
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 890,
      cacheWriteTokens: 111,
    };
    const base = computeTokenCost(input);
    const parity = computeHarnessCost(input);
    expect(parity.costUsd).toBe(base.costUsd);
    expect(parity.inputCostUsd).toBe(base.inputCostUsd);
    expect(parity.outputCostUsd).toBe(base.outputCostUsd);
    expect(parity.webSearchCostUsd).toBe(0);
    expect(parity.fastModeApplied).toBe(false);
    // No one-hour breakdown supplied ⇒ no TTL premium.
    expect(parity.cacheWriteTtlPremiumUsd).toBe(0);
    // Library-priced (not fallback) path ⇒ the fallback flag is false.
    expect(parity.unknownModelFallbackApplied).toBe(false);
  });
});

describe("cache-write TTL premium (FEA-3419)", () => {
  // The multiplier constants encode Anthropic's prompt-caching pricing: a
  // five-minute ephemeral write is 1.25× base input, a one-hour write is 2×.
  // genai-prices bakes ONLY the 1.25× rate into `cache_write_mtok`, so a
  // one-hour write is under-priced by the (2 − 1.25)/1.25 = 0.6× delta.
  it("declares the correct Anthropic prompt-cache multipliers", () => {
    expect(CACHE_WRITE_5M_MULTIPLIER).toBe(1.25);
    expect(CACHE_WRITE_1H_MULTIPLIER).toBe(2.0);
    // Extra fraction of the library's (five-minute) cache-write cost owed for a
    // one-hour write.
    expect(CACHE_WRITE_1H_PREMIUM_OVER_5M).toBeCloseTo(0.6, 12);
  });

  // Opus 4.1: genai-prices prices its cache-write at exactly the five-minute
  // 1.25× rate — $18.75/M against its $15/M input (verified against the
  // library). That makes it a KNOWN-RATE anchor: a one-hour write of the same
  // tokens must land at the 2× rate, $30/M.
  const OPUS_41 = "claude-opus-4-1";
  const OPUS_41_INPUT_PER_M = 15;
  const OPUS_41_CACHE_WRITE_5M_PER_M =
    OPUS_41_INPUT_PER_M * CACHE_WRITE_5M_MULTIPLIER; // $18.75/M
  const OPUS_41_CACHE_WRITE_1H_PER_M =
    OPUS_41_INPUT_PER_M * CACHE_WRITE_1H_MULTIPLIER; // $30/M

  it("leaves an all-five-minute row at the library's 1.25× rate (no premium)", () => {
    const N = 1_000_000;
    const base = computeTokenCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
    });
    // Precondition: the library's own cache-write rate is the 1.25× tier.
    expect((base.cacheWriteCostUsd ?? 0) / (N / 1e6)).toBeCloseTo(
      OPUS_41_CACHE_WRITE_5M_PER_M,
      6
    );
    // Omitting cacheWrite1hTokens ⇒ priced entirely at five minutes.
    const noSplit = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
    });
    expect(noSplit.cacheWriteTtlPremiumUsd).toBe(0);
    expect(noSplit.cacheWriteCostUsd).toBe(base.cacheWriteCostUsd);
    // An explicit zero one-hour count is the same no-op.
    const zeroSplit = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: 0,
    });
    expect(zeroSplit.cacheWriteTtlPremiumUsd).toBe(0);
    expect(zeroSplit.cacheWriteCostUsd).toBe(base.cacheWriteCostUsd);
  });

  it("prices an all-one-hour row at the 2× rate ($30/M for Opus 4.1)", () => {
    const N = 1_000_000;
    const fiveMin = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
    });
    const oneHour = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: N,
    });
    // The corrected cache-write cost is exactly the 2× one-hour rate.
    expect(oneHour.cacheWriteCostUsd ?? 0).toBeCloseTo(
      (N / 1e6) * OPUS_41_CACHE_WRITE_1H_PER_M,
      9
    );
    // Which is strictly MORE than the five-minute pricing — the under-count the
    // fix closes.
    expect(oneHour.cacheWriteCostUsd ?? 0).toBeGreaterThan(
      fiveMin.cacheWriteCostUsd ?? 0
    );
    // The premium is the exact 5m→1h delta: $30/M − $18.75/M = $11.25/M.
    expect(oneHour.cacheWriteTtlPremiumUsd).toBeCloseTo(
      (N / 1e6) * (OPUS_41_CACHE_WRITE_1H_PER_M - OPUS_41_CACHE_WRITE_5M_PER_M),
      9
    );
    // And it is folded into the row total.
    expect(oneHour.costUsd ?? 0).toBeCloseTo(
      (fiveMin.costUsd ?? 0) + oneHour.cacheWriteTtlPremiumUsd,
      9
    );
  });

  it("prices a mixed row proportionally (half one-hour ⇒ midpoint rate)", () => {
    const N = 1_000_000;
    const half = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: N / 2,
    });
    // Half at $18.75/M, half at $30/M ⇒ blended $24.375/M.
    const expectedPerM =
      (OPUS_41_CACHE_WRITE_5M_PER_M + OPUS_41_CACHE_WRITE_1H_PER_M) / 2;
    expect((half.cacheWriteCostUsd ?? 0) / (N / 1e6)).toBeCloseTo(
      expectedPerM,
      6
    );
    // Premium is only on the one-hour half.
    expect(half.cacheWriteTtlPremiumUsd).toBeCloseTo(
      (N / 2 / 1e6) *
        (OPUS_41_CACHE_WRITE_1H_PER_M - OPUS_41_CACHE_WRITE_5M_PER_M),
      9
    );
  });

  it("general property: a one-hour write always costs 1.6× a five-minute write of the same tokens", () => {
    // Model-agnostic: whatever the library charges for five minutes, the
    // one-hour corrected cost is 2/1.25 = 1.6× that, per token. Cover a few
    // priced models so the property isn't tied to one rate table entry.
    for (const model of [
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
    ]) {
      const N = 400_000;
      const fiveMin = computeHarnessCost({
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: N,
      });
      const oneHour = computeHarnessCost({
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: N,
        cacheWrite1hTokens: N,
      });
      expect(fiveMin.priced).toBe(true);
      expect((fiveMin.cacheWriteCostUsd ?? 0) > 0).toBe(true);
      expect(oneHour.cacheWriteCostUsd ?? 0).toBeCloseTo(
        (fiveMin.cacheWriteCostUsd ?? 0) *
          (CACHE_WRITE_1H_MULTIPLIER / CACHE_WRITE_5M_MULTIPLIER),
        9
      );
    }
  });

  it("reproduces the FEA-3419 evidence-session under-count (90,091 one-hour tokens)", () => {
    // The evidence session's writes were one-hour writes the library priced at
    // the five-minute rate. On a $10/M-input model that is $12.50/M charged vs
    // $20/M owed. Fable 5 is the library-priced $10/M anchor, so this pins the
    // exact ticket values rather than only the 1.6x relationship.
    const N = 90_091;
    const charged = computeHarnessCost({
      model: "claude-fable-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
    });
    const corrected = computeHarnessCost({
      model: "claude-fable-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: N,
    });
    expect(charged.cacheWriteCostUsd).toBeCloseTo(1.126_137_5, 9);
    expect(corrected.cacheWriteTtlPremiumUsd).toBeCloseTo(0.675_682_5, 9);
    expect(corrected.cacheWriteCostUsd).toBeCloseTo(1.801_82, 9);
    expect(corrected.costUsd).toBeCloseTo(1.801_82, 9);
  });

  it("refuses a one-hour count that exceeds the cache-write total (no silent clamp)", () => {
    const N = 100_000;
    const malformed = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: N * 5, // malformed: larger than the write bucket
    });
    // A subdivision bigger than its bucket is corrupt input, not something to
    // repair: clamping it would price a TTL mix we know we don't have. The sync
    // ingest boundary rejects this same shape
    // (apps/api/lib/desktop-agent-sessions-schema.ts), so the engine agrees with
    // it rather than quietly pricing what ingest refuses to store.
    expect(malformed.priced).toBe(false);
    expect(malformed.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(malformed.costUsd).toBeNull();
    expect(malformed.cacheWriteTtlPremiumUsd).toBe(0);
  });

  it("refuses a negative / non-finite one-hour count", () => {
    const N = 100_000;
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = computeHarnessCost({
        model: OPUS_41,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: N,
        cacheWrite1hTokens: bad,
      });
      expect(result.priced).toBe(false);
      expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
      expect(result.costUsd).toBeNull();
    }
  });

  it("prices a one-hour count exactly equal to the write bucket (the boundary is inclusive)", () => {
    const N = 100_000;
    const boundary = computeHarnessCost({
      model: OPUS_41,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      cacheWrite1hTokens: N,
    });
    expect(boundary.priced).toBe(true);
    expect(boundary.cacheWriteTtlPremiumUsd).toBeGreaterThan(0);
  });

  it("leaves cache-READ, input, and output pricing untouched", () => {
    const input = {
      model: OPUS_41,
      inputTokens: 500,
      outputTokens: 250,
      cacheReadTokens: 8000,
      cacheWriteTokens: 2000,
    };
    const base = computeTokenCost(input);
    const withTtl = computeHarnessCost({ ...input, cacheWrite1hTokens: 2000 });
    // Only cache-write moves; every other component is byte-identical.
    expect(withTtl.cacheReadCostUsd).toBe(base.cacheReadCostUsd);
    expect(withTtl.inputCostUsd).toBe(base.inputCostUsd);
    expect(withTtl.outputCostUsd).toBe(base.outputCostUsd);
    expect(withTtl.cacheWriteTtlPremiumUsd).toBeGreaterThan(0);
    expect(withTtl.cacheWriteCostUsd ?? 0).toBeGreaterThan(
      base.cacheWriteCostUsd ?? 0
    );
  });

  it("adds the one-hour premium on top of the fast-mode Opus 4.6 tier", () => {
    // Fast Opus 4.6 cache-write is $37.5/M (1.25× the $30 fast input). A
    // one-hour write there must reach 2× = $60/M.
    const N = 1_000_000;
    const fastFiveMin = computeHarnessCost({
      model: "claude-opus-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      fast: true,
    });
    const fastOneHour = computeHarnessCost({
      model: "claude-opus-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
      fast: true,
      cacheWrite1hTokens: N,
    });
    expect(fastOneHour.fastModeApplied).toBe(true);
    expect((fastFiveMin.cacheWriteCostUsd ?? 0) / (N / 1e6)).toBeCloseTo(
      37.5,
      6
    );
    expect((fastOneHour.cacheWriteCostUsd ?? 0) / (N / 1e6)).toBeCloseTo(60, 6);
    // costUsd must ADD the premium (pins the `+ cacheWriteTtlPremiumUsd` in the
    // fast branch): $37.5/M base cache-write + $22.5/M premium = $60/M.
    expect(fastOneHour.costUsd).toBeCloseTo(60, 6);
  });

  it("adds the one-hour premium on top of the unknown-model fallback tier", () => {
    // Fallback tier is Opus-standard ($5 input ⇒ $6.25/M cache-write 5m ⇒
    // $10/M 1h). A newer-than-the-table model with one-hour writes must still
    // get the premium.
    const N = 1_000_000;
    const input = {
      model: "totally-unknown-model-xyz",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: N,
    };
    const base = computeTokenCost(input);
    expect(base.priced).toBe(false); // precondition: library can't price it
    const oneHour = computeHarnessCost({ ...input, cacheWrite1hTokens: N });
    expect(oneHour.unknownModelFallbackApplied).toBe(true);
    expect((oneHour.cacheWriteCostUsd ?? 0) / (N / 1e6)).toBeCloseTo(10, 6);
    expect(oneHour.cacheWriteTtlPremiumUsd).toBeCloseTo((N / 1e6) * 3.75, 9);
    // costUsd adds the premium (pins the `+` in the fallback branch): $6.25/M
    // base cache-write + $3.75/M premium = $10/M.
    expect(oneHour.costUsd).toBeCloseTo(10, 6);
  });
});

describe("corrupt token counts — reconciled with computeTokenCost invalid_count (ISS-4730)", () => {
  const valid = {
    model: "claude-opus-4-6",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  it("refuses a negative count in fast-mode Opus 4.6 instead of silently pricing it", () => {
    // The fast path prices via tierTokenCost, which never calls the engine —
    // so without the `countsValid` gate this row returns priced:true at the
    // fast tier, bypassing the invalid_count refusal entirely.
    const result = computeHarnessCost({
      ...valid,
      inputTokens: -50,
      fast: true,
    });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.costUsd).toBeNull();
    expect(result.fastModeApplied).toBe(false);
  });

  it("refuses a non-finite count in fast-mode Opus 4.6", () => {
    const result = computeHarnessCost({
      ...valid,
      cacheReadTokens: Number.POSITIVE_INFINITY,
      fast: true,
    });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.costUsd).toBeNull();
    expect(result.fastModeApplied).toBe(false);
  });

  it("refuses a corrupt count on the non-fast (library) path", () => {
    const result = computeHarnessCost({ ...valid, outputTokens: Number.NaN });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.costUsd).toBeNull();
  });

  it("does NOT launder a corrupt count into the unknown-model fallback", () => {
    // An unknown model + a corrupt count must stay invalid_count, never a priced
    // Opus-standard fallback (invalid_count is not a fallback reason).
    const result = computeHarnessCost({
      model: "totally-made-up-model-xyz",
      inputTokens: -1,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.unknownModelFallbackApplied).toBe(false);
  });

  it("still prices a VALID fast-mode Opus 4.6 row (regression)", () => {
    const result = computeHarnessCost({ ...valid, fast: true });
    expect(result.priced).toBe(true);
    expect(result.fastModeApplied).toBe(true);
    expect(result.costUsd ?? 0).toBeGreaterThan(0);
  });
});
