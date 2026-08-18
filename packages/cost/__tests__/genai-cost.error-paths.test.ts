import { beforeEach, describe, expect, it, vi } from "vitest";

import { computeTokenCost, TokenCostNotPricedReason } from "../src/genai-cost";

/**
 * Coverage for the two DEFENSIVE branches in `computeTokenCost` that a
 * well-formed input can never reach, so the real-library suite
 * (`genai-cost.test.ts`) cannot exercise them:
 *
 *   1. `compute_error` — `calcPrice` throwing. The additive `buildUsage`
 *      reconstructs `input_tokens = input + cacheRead + cacheWrite`, so the
 *      library re-derives `uncached = input ≥ 0` and never hits the negative-
 *      uncached throw (FEA-2082). The catch is still load-bearing insurance
 *      against any other library throw, and its contract is: NEVER crash the
 *      cost path — return a typed `compute_error` (carrying the resolved
 *      provider) so the caller can render "—".
 *   2. The `isolateCacheCosts` catch — a per-cache sub-`calcPrice` throwing after
 *      the main price succeeded. Contract: still return the priced total, fall
 *      the whole input cost back to the library's `input_price`, and null out the
 *      per-cache split so the caller shows a total without a bogus breakdown.
 *
 * Both are reachable only by making the library throw, so this file mocks
 * `@pydantic/genai-prices`. `vi.mock` + `vi.hoisted` are lifted above the imports
 * at transform time, so the module under test binds these mocks. Kept in a
 * separate file so the real-library suite stays mock-free.
 */
const { calcPriceMock, findProviderMock } = vi.hoisted(() => ({
  calcPriceMock: vi.fn(),
  findProviderMock: vi.fn(),
}));

vi.mock("@pydantic/genai-prices", () => ({
  calcPrice: calcPriceMock,
  findProvider: findProviderMock,
}));

// The subset of a genai-prices `PriceCalculation` that `computeTokenCost` reads.
const PRICED_RESULT = {
  input_price: 0.01,
  output_price: 0.002,
  total_price: 0.012,
  provider: { id: "anthropic" },
};

beforeEach(() => {
  calcPriceMock.mockReset();
  findProviderMock.mockReset();
  // A resolvable provider so the not-priced result carries a provider id, not null.
  findProviderMock.mockReturnValue({ id: "anthropic" });
});

describe("computeTokenCost — defensive error branches", () => {
  it("returns a typed compute_error (never throws) when the library throws", () => {
    calcPriceMock.mockImplementation(() => {
      throw new Error("simulated genai-prices failure");
    });

    const result = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(result).toEqual({
      priced: false,
      // The resolved provider is preserved on the not-priced result.
      provider: "anthropic",
      costUsd: null,
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      cacheWriteCostUsd: null,
      reason: TokenCostNotPricedReason.ComputeError,
    });
  });

  it("falls cache split back to null (keeping the priced total) when cache isolation throws", () => {
    // Main price succeeds; the isolateCacheCosts sub-call then throws.
    calcPriceMock.mockReturnValueOnce(PRICED_RESULT).mockImplementation(() => {
      throw new Error("simulated cache-isolation failure");
    });

    const result = computeTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    });

    // Still priced from the main result — the throw is contained to the split.
    expect(result.priced).toBe(true);
    expect(result.provider).toBe("anthropic");
    expect(result.costUsd).toBe(PRICED_RESULT.total_price);
    expect(result.outputCostUsd).toBe(PRICED_RESULT.output_price);
    // Whole input cost falls back to the library's input_price; the per-cache
    // split is nulled so the caller renders a total without a bogus breakdown.
    expect(result.inputCostUsd).toBe(PRICED_RESULT.input_price);
    expect(result.cacheReadCostUsd).toBeNull();
    expect(result.cacheWriteCostUsd).toBeNull();
    expect(result.reason).toBeNull();
  });
});
