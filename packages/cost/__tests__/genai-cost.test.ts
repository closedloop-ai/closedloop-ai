import { describe, expect, it } from "vitest";

import {
  buildUsage,
  computeTokenCost,
  type TokenCostInput,
  TokenCostNotPricedReason,
} from "../src/genai-cost";

/**
 * Package-local correctness tests for the canonical genai-cost engine
 * (FEA-1718 / Q-F). The desktop parity test
 * (`apps/desktop/test/token-cost.test.ts`) remains the cross-package guard
 * against `@pydantic/genai-prices`' own `extractUsage`; this suite pins the
 * engine's own behavior so `pnpm -C packages/loops-api test` covers it too.
 * Dollar values are pinned against the version of `@pydantic/genai-prices` this
 * package depends on — if the library changes a rate, update these deliberately.
 */

// Fixture matrix over the real-library paths: well-formed pricing (fresh +
// additive cache) and unpriced models (no_match, empty-string unknown_model).
// Invalid counts (negative / non-finite) refuse with `invalid_count` + null cost
// rather than coerce to zero — covered by their own cases below (the ingest
// parser is what keeps such values out of the DB in the first place). The
// defensive error branches (compute_error, the
// cache-isolation catch) can't be reached with well-formed input — the additive
// `buildUsage` keeps uncached ≥ 0 — so they are covered with a mocked library in
// `genai-cost.error-paths.test.ts`. Timestamped pricing has its own case below.
const wellFormedCases: ReadonlyArray<{ name: string; input: TokenCostInput }> =
  [
    {
      name: "anthropic fresh input only",
      input: {
        model: "claude-opus-4-5",
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    {
      name: "anthropic with cache (additive grand total)",
      input: {
        model: "claude-opus-4-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 300,
      },
    },
    {
      name: "openai fresh input, no cache",
      input: {
        model: "gpt-4.1",
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    {
      name: "unknown model (no_match)",
      input: {
        model: "totally-made-up-model-xyz",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
      },
    },
    {
      name: "empty model (unknown_model)",
      input: {
        model: "",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  ];

describe("computeTokenCost", () => {
  it.each(wellFormedCases)(
    "returns a well-formed result: $name",
    ({ input }) => {
      const result = computeTokenCost(input);
      expect(typeof result.priced).toBe("boolean");
      if (result.priced) {
        expect(typeof result.costUsd).toBe("number");
        expect(result.costUsd ?? -1).toBeGreaterThanOrEqual(0);
        expect(result.reason).toBeNull();
      } else {
        expect(result.costUsd).toBeNull();
        expect(typeof result.reason).toBe("string");
        expect(result.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }
  );

  it("pins known dollar values against the pinned genai-prices version", () => {
    // claude-opus-4-5 input rate is $5/Mtok → 1000 input = $0.005.
    const opusFresh = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(opusFresh.priced).toBe(true);
    expect(opusFresh.provider).toBe("anthropic");
    expect(opusFresh.costUsd).toBe(0.005);

    // Anthropic cache is ADDITIVE: grand total = 1000 + 500 + 300 = 1800
    // (uncached 1000 @ $5, cache_read 500 @ $0.5, cache_write 300 @ $6.25).
    const opusCache = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    });
    expect(opusCache.priced).toBe(true);
    expect(opusCache.costUsd).toBe(0.007_125);

    // gpt-4.1 input rate is $2/Mtok → total = input + cacheRead + cacheWrite =
    // 1000 + 0 + 0 = 1000 → $0.002. cacheRead/cacheWrite are zero here, so the
    // always-additive reconstruction and the raw input give the same result.
    const gptFresh = computeTokenCost({
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(gptFresh.priced).toBe(true);
    expect(gptFresh.provider).toBe("openai");
    expect(gptFresh.costUsd).toBe(0.002);
  });

  // ISS-7361: rates pinned against @pydantic/genai-prices 0.1.9 (the anthropic rows
  // first against 0.1.6, pydantic/genai-prices PR #671) and
  // https://platform.claude.com/docs/en/about-claude/pricing. Each
  // bucket is priced in isolation at 1000 tokens so the four $/MTok rates read
  // straight off the assertion. fable-5-1's cache-read rate is the point of the
  // bump: 0.0.66 prefix-matched it to claude-fable-5 and charged $1.00/MTok
  // instead of $0.25. opus-5 and sonnet-5 were no_match before 0.1.6, so every
  // event on them fell to the fallback tier. opus-4-8 is unchanged and guards
  // against a future bump silently repricing history. ISS-11736 adds the two
  // GPT-6 rows, pinned against 0.1.9 and https://developers.openai.com/api/docs/pricing:
  // both were no_match on 0.1.6, which is what fired the pricing-miss monitor.
  // It also adds opus-5-5: 0.1.6 prefix-matched it to claude-opus-5 at
  // 5 / 6.25 / 0.5 / 25, 0.1.9 gives it its own 4 / 5 / 0.2 / 20, and that move
  // reprices stored compacted rows on the next desktop boot.
  it.each(pinnedRateCases)(
    "pins $model at $input / $cacheWrite / $cacheRead / $output $/MTok",
    ({ model, provider, input, cacheWrite, cacheRead, output }) => {
      const result = computeTokenCost({
        model,
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 1000,
        cacheWriteTokens: 1000,
      });
      expect(result.priced).toBe(true);
      expect(result.reason).toBeNull();
      expect(result.provider).toBe(provider);
      expect(result.inputCostUsd).toBeCloseTo(input / 1000, 12);
      expect(result.cacheWriteCostUsd).toBeCloseTo(cacheWrite / 1000, 12);
      expect(result.cacheReadCostUsd).toBeCloseTo(cacheRead / 1000, 12);
      expect(result.outputCostUsd).toBeCloseTo(output / 1000, 12);
    }
  );

  // ISS-7361 (review): the gpt-5.5 long-context tier is the one number this bump
  // turns on, and it is what makes a fold-then-price call site over-charge. None
  // of the pinned rows above can catch it — each prices 3K prompt tokens, far
  // below any tier, so the tiered GPT-6 rows read only their base rates — so a
  // later bump that walks the threshold down would widen the over-charge with
  // every test still green. These two pin the boundary itself.
  it("pins the gpt-5.5 long-context threshold at 272_000 prompt tokens (ISS-7361)", () => {
    const below = computeTokenCost({
      model: "gpt-5.5",
      inputTokens: GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS - 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const atThreshold = computeTokenCost({
      model: "gpt-5.5",
      inputTokens: GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(below.priced).toBe(true);
    expect(atThreshold.priced).toBe(true);
    // One token below the threshold is the base rate; the threshold itself is
    // the tier. Both directions are pinned so a move either way fails.
    expect(
      ((below.inputCostUsd ?? 0) / (GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS - 1)) *
        1_000_000
    ).toBeCloseTo(5, 9);
    expect(
      ((atThreshold.inputCostUsd ?? 0) / GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS) *
        1_000_000
    ).toBeCloseTo(10, 9);
  });

  it.each(gpt55TierRateCases)(
    "pins gpt-5.5 $bucket at $below $/MTok below and $above $/MTok at the long-context tier (ISS-7361)",
    ({ bucket, below, above }) => {
      // The threshold is measured on the PROMPT total, which `buildUsage` sums
      // as input + cacheRead + cacheWrite. Each prompt bucket is therefore
      // driven alone at the boundary so its own rate is what the assertion
      // reads; `output` needs a prompt to select the tier, so it rides on an
      // input bucket held at each side of the boundary.
      const rateAt = (promptTokens: number): number => {
        const result = computeTokenCost({
          model: "gpt-5.5",
          inputTokens:
            bucket === "cacheRead" || bucket === "cacheWrite"
              ? 0
              : promptTokens,
          outputTokens: bucket === "output" ? 1_000_000 : 0,
          cacheReadTokens: bucket === "cacheRead" ? promptTokens : 0,
          cacheWriteTokens: bucket === "cacheWrite" ? promptTokens : 0,
        });
        expect(result.priced).toBe(true);
        if (bucket === "output") {
          return result.outputCostUsd ?? 0;
        }
        const costByBucket = {
          input: result.inputCostUsd ?? 0,
          cacheRead: result.cacheReadCostUsd ?? 0,
          cacheWrite: result.cacheWriteCostUsd ?? 0,
        };
        return (costByBucket[bucket] / promptTokens) * 1_000_000;
      };

      expect(rateAt(GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS - 1)).toBeCloseTo(
        below,
        9
      );
      expect(rateAt(GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS)).toBeCloseTo(
        above,
        9
      );
    }
  );

  it("prices gpt-5.6-sol (priced since 0.1.6) and still refuses big-pickle (ISS-7361)", () => {
    const sol = computeTokenCost({
      model: "gpt-5.6-sol",
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(sol.priced).toBe(true);
    expect(sol.provider).toBe("openai");
    expect(sol.costUsd ?? 0).toBeGreaterThan(0);

    // big-pickle is unpriced by design; it stays no_match on this bump.
    const pickle = computeTokenCost({
      model: "big-pickle",
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(pickle.priced).toBe(false);
    expect(pickle.reason).toBe(TokenCostNotPricedReason.NoMatch);
  });

  it("splits cache cost into cacheReadCostUsd and cacheWriteCostUsd (FEA-2344)", () => {
    const result = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    });
    expect(result.priced).toBe(true);
    expect(result.costUsd).toBe(0.012_125);
    expect(result.inputCostUsd).toBe(0.005);
    expect(result.outputCostUsd).toBe(0.005);
    expect(result.cacheWriteCostUsd).toBe(0.001_875);
    expect(result.cacheReadCostUsd).toBeCloseTo(0.000_25, 12);
    const componentSum =
      (result.inputCostUsd ?? 0) +
      (result.outputCostUsd ?? 0) +
      (result.cacheReadCostUsd ?? 0) +
      (result.cacheWriteCostUsd ?? 0);
    expect(Math.abs(componentSum - (result.costUsd ?? 0))).toBeLessThan(1e-12);
  });

  it("returns zero cache costs when no cache tokens (FEA-2344 short-circuit)", () => {
    const result = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.priced).toBe(true);
    expect(result.cacheReadCostUsd).toBe(0);
    expect(result.cacheWriteCostUsd).toBe(0);
  });

  it("surfaces a typed reason for unpriced models, never a wrong number", () => {
    expect(
      computeTokenCost({
        model: "totally-made-up-model-xyz",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    ).toEqual({
      priced: false,
      provider: null,
      costUsd: null,
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      reason: TokenCostNotPricedReason.NoMatch,
    });

    const empty = computeTokenCost({
      model: "",
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(empty.priced).toBe(false);
    expect(empty.reason).toBe(TokenCostNotPricedReason.UnknownModel);
  });

  it("treats a non-string model from a parsed payload as unknown_model", () => {
    // A JSON row can carry any type in `model`; the type annotation does not
    // hold at runtime, so a number must not reach the library as a model id.
    const input: TokenCostInput = JSON.parse(
      '{"model":42,"inputTokens":100,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}'
    );
    const result = computeTokenCost(input);
    expect(result.priced).toBe(false);
    expect(result.provider).toBeNull();
    expect(result.reason).toBe(TokenCostNotPricedReason.UnknownModel);
  });

  it("refuses a negative token count with invalid_count + null cost, not a lying $0", () => {
    // Corrupt counts can't be priced correctly. Refuse with a typed reason and a
    // null "unknown" cost — never swept to 0 and priced as if the component were
    // absent. `invalid_count` rides the pricing-miss seam to DataDog; the caller
    // degrades gracefully instead of crashing.
    const result = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: -50,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.priced).toBe(false);
    expect(result.reason).toBe(TokenCostNotPricedReason.InvalidCount);
    expect(result.costUsd).toBeNull();
  });

  it("refuses a non-finite token count (NaN / Infinity) with invalid_count", () => {
    const base = {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(computeTokenCost({ ...base, outputTokens: Number.NaN }).reason).toBe(
      TokenCostNotPricedReason.InvalidCount
    );
    expect(
      computeTokenCost({
        ...base,
        cacheReadTokens: Number.POSITIVE_INFINITY,
      }).reason
    ).toBe(TokenCostNotPricedReason.InvalidCount);
  });

  it("prices through the explicit timestamp path (historical/timestamped costing)", () => {
    const base = {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } as const;
    const untimed = computeTokenCost(base);

    // A `timestamp` routes through `options = { timestamp }` — a branch none of
    // the other cases take. A fixed, current-range date resolves to the same
    // rate as the default (un-timestamped) path, so the two must agree; pinning
    // a literal Date keeps this off the real clock.
    const timed = computeTokenCost({
      ...base,
      timestamp: new Date("2026-07-31T00:00:00.000Z"),
    });

    expect(timed.priced).toBe(true);
    expect(timed.provider).toBe("anthropic");
    expect(timed.costUsd).toBe(untimed.costUsd);
    expect(timed.costUsd).toBe(0.005);
  });
});

describe("buildUsage always sums to the genai-prices grand total", () => {
  const counts = { input: 1000, output: 0, cacheRead: 500, cacheWrite: 300 };

  it("sums cache into input_tokens for every provider (no per-provider branch)", () => {
    // Counts are always the canonical fresh shape, so input_tokens is always
    // input + cacheRead + cacheWrite regardless of provider.
    expect(buildUsage(counts).input_tokens).toBe(1800);
  });
});

// $/MTok: input / cache-write / cache-read / output.
const pinnedRateCases = [
  {
    model: "claude-opus-5",
    provider: "anthropic",
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
  },
  {
    model: "claude-sonnet-5",
    provider: "anthropic",
    input: 2,
    cacheWrite: 2.5,
    cacheRead: 0.2,
    output: 10,
  },
  {
    model: "claude-fable-5",
    provider: "anthropic",
    input: 10,
    cacheWrite: 12.5,
    cacheRead: 1,
    output: 50,
  },
  {
    model: "claude-fable-5-1",
    provider: "anthropic",
    input: 10,
    cacheWrite: 12.5,
    cacheRead: 0.25,
    output: 50,
  },
  {
    model: "claude-opus-4-8",
    provider: "anthropic",
    input: 5,
    cacheWrite: 6.25,
    cacheRead: 0.5,
    output: 25,
  },
  {
    model: "claude-opus-5-5",
    provider: "anthropic",
    input: 4,
    cacheWrite: 5,
    cacheRead: 0.2,
    output: 20,
  },
  {
    model: "gpt-6-astra",
    provider: "openai",
    input: 10,
    cacheWrite: 12.5,
    cacheRead: 1,
    output: 50,
  },
  {
    model: "gpt-6-luna",
    provider: "openai",
    input: 0.1,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    output: 0.5,
  },
] as const;

/**
 * ISS-7361: the prompt-token count at which `gpt-5.5` switches to its
 * long-context tier in `@pydantic/genai-prices` 0.1.9. Measured on the PROMPT
 * total (`buildUsage` sums input + cacheRead + cacheWrite): 271_999 prices at
 * the base rate, 272_000 at the tier.
 */
const GPT_55_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

// $/MTok on each side of the gpt-5.5 long-context boundary. Measured against
// 0.1.9; the tier doubles every prompt bucket and takes output from 30 to 45.
const gpt55TierRateCases = [
  { bucket: "input", below: 5, above: 10 },
  { bucket: "cacheWrite", below: 5, above: 10 },
  { bucket: "cacheRead", below: 0.5, above: 1 },
  { bucket: "output", below: 30, above: 45 },
] as const;
