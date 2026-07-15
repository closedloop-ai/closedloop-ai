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

// Fixture matrix exercising every code path: always-additive grand total,
// cache combos, unpriced models, empty model, and zero/negative/string coercion.
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
    {
      name: "negative + NaN-ish counts are coerced to zero",
      input: {
        model: "claude-opus-4-5",
        inputTokens: -50,
        outputTokens: Number.NaN,
        cacheReadTokens: -10,
        cacheWriteTokens: 0,
      },
    },
  ];

describe("computeTokenCost", () => {
  it.each(wellFormedCases)("returns a well-formed result: $name", ({
    input,
  }) => {
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
  });

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
});

describe("buildUsage always sums to the genai-prices grand total", () => {
  const counts = { input: 1000, output: 0, cacheRead: 500, cacheWrite: 300 };

  it("sums cache into input_tokens for every provider (no per-provider branch)", () => {
    // Counts are always the canonical fresh shape, so input_tokens is always
    // input + cacheRead + cacheWrite regardless of provider.
    expect(buildUsage(counts).input_tokens).toBe(1800);
  });
});
