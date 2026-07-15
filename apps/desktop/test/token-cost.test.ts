/**
 * @file token-cost.test.ts
 * @description Correctness tests for the first-party token-cost engine
 * (`src/shared/token-cost.ts`). FEA-1503 removed the vendor CJS twin
 * (`scripts/agent-monitor-cost/cost-pricing.js`); the first-party engine is now
 * the single source of truth, so this exercises it directly.
 *
 * It pins a handful of known dollar values (against the pinned
 * @pydantic/genai-prices version) and verifies the engine ALWAYS reconstructs
 * the genai-prices grand total additively (input + cacheRead + cacheWrite) —
 * the canonical fresh shape every parser emits (see NormalizedTokenCounts).
 */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  buildUsage as buildUsageTwin,
  computeTokenCost as computeTokenCostTwin,
  estimateTokenCost,
  type TokenCostInput,
  TokenCostNotPricedReason,
} from "../src/shared/token-cost.js";

// VALID inputs: a recognized model the genai-prices library can price. Each row
// pins the EXACT costUsd the engine returns against the pinned
// @pydantic/genai-prices version — values captured from the engine itself, so
// the literals are representation-clean and safe for assert.equal. A library
// bump that drops or reprices a model fails CI here instead of silently zeroing
// a session's cost. The four gpt-5.* rows are the models Datadog flagged as
// token_cost.pricing_miss in production (FEA-2082); pinning them turns a
// would-be silent miss into a red test.
const VALID_INPUT_FIXTURE: Array<{
  name: string;
  input: TokenCostInput;
  expectedProvider: string;
  expectedCostUsd: number;
}> = [
  {
    name: "anthropic fresh input only",
    input: {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    expectedProvider: "anthropic",
    expectedCostUsd: 0.005,
  },
  {
    name: "anthropic cache, no output (additive grand total)",
    input: {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    },
    expectedProvider: "anthropic",
    expectedCostUsd: 0.007_125,
  },
  {
    name: "anthropic with cache + output (additive grand total)",
    input: {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    },
    expectedProvider: "anthropic",
    expectedCostUsd: 0.012_125,
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
    expectedProvider: "openai",
    expectedCostUsd: 0.002,
  },
  {
    // `inputTokens: 1025` is the uncached fresh input count. Cache read/write
    // tokens stay separate and are always added into the pricing usage.
    name: "openai fresh input with cache + output (always additive)",
    input: {
      model: "gpt-4.1",
      inputTokens: 1025,
      outputTokens: 510,
      cacheReadTokens: 255,
      cacheWriteTokens: 100,
    },
    expectedProvider: "openai",
    expectedCostUsd: 0.006_457_5,
  },
  // FEA-2082 — OpenAI models reported by Datadog (token_cost.pricing_miss) as
  // unpriced in production. Stored in the canonical fresh shape (input uncached,
  // cache separate); the engine sums them to the grand total before pricing.
  {
    name: "gpt-5.4 input + output + cache subset",
    input: {
      model: "gpt-5.4",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    },
    expectedProvider: "openai",
    expectedCostUsd: 0.010_05,
  },
  {
    name: "gpt-5-codex input + output + cache subset",
    input: {
      model: "gpt-5-codex",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    },
    expectedProvider: "openai",
    expectedCostUsd: 0.006_275,
  },
  {
    name: "gpt-5.4-mini input + output + cache subset",
    input: {
      model: "gpt-5.4-mini",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    },
    expectedProvider: "openai",
    expectedCostUsd: 0.003_015,
  },
  {
    name: "gpt-5.5 input + output + cache subset",
    input: {
      model: "gpt-5.5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
    },
    expectedProvider: "openai",
    expectedCostUsd: 0.0201,
  },
  {
    name: "all zero tokens",
    input: {
      model: "claude-opus-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    expectedProvider: "anthropic",
    expectedCostUsd: 0,
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
    expectedProvider: "anthropic",
    expectedCostUsd: 0,
  },
  {
    name: "timestamped historical pricing",
    input: {
      model: "claude-opus-4-5",
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: new Date("2026-01-15T00:00:00.000Z"),
    },
    expectedProvider: "anthropic",
    expectedCostUsd: 0.0075,
  },
];

// INVALID inputs: the engine cannot price the model, so it must refuse cleanly
// and never invent a number. `expectedReason` distinguishes the two refusal
// paths, which map 1:1 to the Datadog token_cost.pricing_miss `reason` enum:
//   • unknown_model — empty model string, short-circuited before the library.
//   • no_match      — non-empty model the library has no pricing entry for.
const INVALID_INPUT_FIXTURE: Array<{
  name: string;
  input: TokenCostInput;
  expectedReason: TokenCostNotPricedReason;
}> = [
  {
    name: "unknown model (no_match)",
    input: {
      model: "totally-made-up-model-xyz",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
    },
    expectedReason: "no_match",
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
    expectedReason: "unknown_model",
  },
];

// HARNESS 1 — valid inputs must price: priced=true, expected provider, and the
// exact expected costUsd. One parameterized `it` per fixture row so each model
// passes/fails independently and the suite runs concurrently. Any model that
// silently stops pricing (library bump, model-id variant) flips priced to false
// and fails only its own case.
describe("valid inputs price to the expected costUsd with priced=true", {
  concurrency: true,
}, () => {
  for (const {
    name,
    input,
    expectedProvider,
    expectedCostUsd,
  } of VALID_INPUT_FIXTURE) {
    it(name, () => {
      const result = computeTokenCostTwin(input);
      assert.equal(result.priced, true, "priced flag");
      assert.equal(result.provider, expectedProvider, "provider");
      assert.equal(typeof result.costUsd, "number", "costUsd type");
      assert.equal(result.costUsd, expectedCostUsd, "costUsd value");
    });
  }
});

// HARNESS 2 — invalid inputs must refuse cleanly: priced=false, costUsd null,
// and a non-empty typed reason matching the expected refusal path. One
// parameterized `it` per fixture row, run concurrently.
describe("invalid inputs refuse cleanly: priced=false, null cost, typed reason", {
  concurrency: true,
}, () => {
  for (const { name, input, expectedReason } of INVALID_INPUT_FIXTURE) {
    it(name, () => {
      const result = computeTokenCostTwin(input);
      assert.equal(result.priced, false, "priced flag");
      assert.equal(result.costUsd, null, "costUsd null");
      assert.ok(
        typeof result.reason === "string" && result.reason.length > 0,
        "reason non-empty string"
      );
      assert.equal(result.reason, expectedReason, "reason value");
    });
  }
});

test("unpriced models surface a typed reason, never a wrong number", () => {
  const unknown = computeTokenCostTwin({
    model: "totally-made-up-model-xyz",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(unknown, {
    priced: false,
    provider: null,
    costUsd: null,
    inputCostUsd: null,
    outputCostUsd: null,
    cacheReadCostUsd: null,
    cacheWriteCostUsd: null,
    reason: TokenCostNotPricedReason.NoMatch,
  });

  const empty = computeTokenCostTwin({
    model: "",
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(empty.priced, false);
  assert.equal(empty.reason, TokenCostNotPricedReason.UnknownModel);
});

test("FEA-2085: gpt-5-codex prices; the bare gpt-codex placeholder does not", () => {
  // The Codex parser's CODEX_FALLBACK_MODEL is "gpt-5-codex" precisely because
  // the engine CAN price it. genai-prices resolves the OpenAI provider loosely
  // (starts_with "gpt-") but prices strictly via exact `equals`, so the bare
  // "gpt-codex" id resolves a provider yet matches no price entry → no_match.
  const codex = computeTokenCostTwin({
    model: "gpt-5-codex",
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(codex.priced, true, "gpt-5-codex must price");
  assert.equal(codex.provider, "openai");
  assert.ok((codex.costUsd ?? 0) > 0, "gpt-5-codex cost must be > 0");

  // If this ever flips to priced=true, genai-prices added a bare "gpt-codex"
  // entry — revisit CODEX_FALLBACK_MODEL. The parser must never emit it either.
  const placeholder = computeTokenCostTwin({
    model: "gpt-codex",
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadTokens: 25,
    cacheWriteTokens: 10,
  });
  assert.equal(placeholder.priced, false, "bare gpt-codex must not price");
  assert.equal(placeholder.reason, "no_match");
});

test("buildUsage always sums to the genai-prices grand total (no per-provider branch)", () => {
  // Counts are ALWAYS the canonical fresh shape (input uncached; cache separate),
  // so input_tokens is always input + cacheRead + cacheWrite — regardless of
  // provider. There is no provider argument anymore.
  const counts = { input: 1000, output: 0, cacheRead: 500, cacheWrite: 300 };
  assert.equal(
    (buildUsageTwin(counts) as { input_tokens: number }).input_tokens,
    1800
  );
});

test("a Codex-shaped fresh row with cacheRead > input prices without compute_error (FEA-2082 regression)", () => {
  // Real Codex steady state: cache-hit rate > 50%, so cacheRead exceeds the
  // uncached input. Under the old openai pass-through the library re-subtracted
  // cache and threw → compute_error. With always-additive the grand total is
  // reconstructed (input + cacheRead + cacheWrite) and uncached = input ≥ 0.
  const result = computeTokenCostTwin({
    model: "gpt-5.5",
    inputTokens: 149_588,
    outputTokens: 1000,
    cacheReadTokens: 406_144,
    cacheWriteTokens: 0,
  });
  assert.equal(result.priced, true, "priced");
  assert.equal(result.reason, null, "no not-priced reason");
  assert.ok((result.costUsd ?? 0) > 0, "positive costUsd");
});

// `estimateTokenCost` is the compat wrapper the desktop sync/branch-cost
// paths call (agent-session-sync-service, branch-usage-projection,
// shared-branches-api) when a row has no stored cost. FEA-2344 replaced the
// residual `cacheCostUsd` with per-component `cacheReadCostUsd` and
// `cacheWriteCostUsd` derived via library-differencing isolation calls.
const LEGACY_COST_FIXTURES: Array<{
  name: string;
  model: string;
}> = [
  { name: "anthropic flagship (claude-opus-4-8)", model: "claude-opus-4-8" },
  { name: "openai flagship (gpt-5.5)", model: "gpt-5.5" },
];

test("estimateTokenCost prices a non-zero costUsd for current flagship models", () => {
  for (const { name, model } of LEGACY_COST_FIXTURES) {
    const estimate = estimateTokenCost({
      model,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
    });
    assert.ok(estimate !== undefined, `priced (defined) for: ${name}`);
    assert.equal(typeof estimate.costUsd, "number", `costUsd number: ${name}`);
    assert.ok(estimate.costUsd > 0, `costUsd strictly positive for: ${name}`);
    assert.equal(
      estimate.inputCostUsd,
      0.005,
      `inputCostUsd pinned for: ${name}`
    );
    const expectedCacheWrite = model.startsWith("claude-") ? 0.001_875 : 0.0015;
    assert.ok(
      Math.abs(estimate.cacheWriteCostUsd - expectedCacheWrite) < 1e-12,
      `cacheWriteCostUsd pinned for: ${name}: ${estimate.cacheWriteCostUsd} vs ${expectedCacheWrite}`
    );
    assert.ok(
      Math.abs(estimate.cacheReadCostUsd - 0.000_25) < 1e-12,
      `cacheReadCostUsd pinned for: ${name}: ${estimate.cacheReadCostUsd} vs 0.00025`
    );
    const componentSum =
      estimate.inputCostUsd +
      estimate.outputCostUsd +
      estimate.cacheReadCostUsd +
      estimate.cacheWriteCostUsd;
    assert.ok(
      Math.abs(componentSum - estimate.costUsd) < 1e-12,
      `components sum to costUsd for: ${name}`
    );
  }
});
