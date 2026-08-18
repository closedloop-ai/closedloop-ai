// biome-ignore-all lint/performance/noBarrelFile: intentional SSOT re-export shim — preserves the `apps/desktop/src/shared/token-cost.ts` import path (and the parity test) while the engine lives in @repo/cost/genai-cost (FEA-1718 / Q-F).
import { computeHarnessCost } from "@repo/cost/harness-cost-parity";

/**
 * @file token-cost.ts
 * @description Compatibility wrapper around the canonical token-cost engine,
 * now owned by `@repo/cost/genai-cost` (FEA-1718 / Q-F) so that
 * `apps/desktop` (synced-session costing, here) and `packages/app` (the
 * browser/cloud cost projectors) share ONE genai-prices costing source — no
 * twin to keep in parity.
 *
 * Desktop importers and the parity test (`test/token-cost.test.ts`) continue to
 * resolve the engine here; the parity test remains the SSOT guard, validating
 * the shared engine against `@pydantic/genai-prices`' own `extractUsage`.
 *
 * `estimateTokenCost` — the single entry point every desktop cost surface uses
 * (synced-session costing, branch usage, write-core re-pricing) — routes through
 * `computeHarnessCost`, which layers Claude-Code parity on top of the library:
 * web-search cost, fast-mode Opus 4.6, and (FEA-3546) an Opus-standard
 * unknown-model fallback so a heavily-used session on a newer-than-the-table
 * model (e.g. Codex `gpt-5.6-sol`) is priced instead of collapsing to $0/null.
 * The pure `computeTokenCost` re-export below is unchanged — the SSOT parity
 * test still exercises the library-pure engine directly.
 */

export {
  buildUsage,
  computeTokenCost,
  type TokenCostInput,
  TokenCostNotPricedReason,
  type TokenCostResult,
} from "@repo/cost/genai-cost";

export type EstimateTokenCostInput = {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cacheReadTokens: number | null | undefined;
  cacheWriteTokens: number | null | undefined;
  /**
   * FEA-3419: how many of `cacheWriteTokens` were ONE-HOUR ephemeral writes
   * (`cache_creation.ephemeral_1h_input_tokens`). Optional subdivision of
   * `cacheWriteTokens`; when omitted/null/0 the whole cache-write bucket is
   * priced at the five-minute rate (existing behavior). Supplying it prices the
   * one-hour portion at the higher one-hour TTL rate.
   */
  cacheWrite1hTokens?: number | null | undefined;
  observedAt?: Date | string | null | undefined;
};

export type EstimateTokenCostResult = {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  /**
   * FEA-3419: the one-hour cache-write TTL premium already included in
   * `costUsd` / `cacheWriteCostUsd`. 0 when no one-hour tokens were supplied.
   */
  cacheWriteTtlPremiumUsd: number;
};

export function estimateTokenCost(
  input: EstimateTokenCostInput
): EstimateTokenCostResult | undefined {
  const observedAt = coerceObservedAt(input.observedAt);
  const result = computeHarnessCost({
    model: input.model ?? "",
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    ...(input.cacheWrite1hTokens == null
      ? {}
      : { cacheWrite1hTokens: input.cacheWrite1hTokens }),
    ...(observedAt ? { timestamp: observedAt } : {}),
  });
  if (!result.priced || result.costUsd == null) {
    return undefined;
  }
  return {
    costUsd: result.costUsd,
    inputCostUsd: result.inputCostUsd ?? 0,
    outputCostUsd: result.outputCostUsd ?? 0,
    cacheReadCostUsd: result.cacheReadCostUsd ?? 0,
    cacheWriteCostUsd: result.cacheWriteCostUsd ?? 0,
    cacheWriteTtlPremiumUsd: result.cacheWriteTtlPremiumUsd,
  };
}

function coerceObservedAt(
  observedAt: Date | string | null | undefined
): Date | undefined {
  if (observedAt instanceof Date) {
    return Number.isNaN(observedAt.getTime()) ? undefined : observedAt;
  }
  if (typeof observedAt !== "string" || observedAt.length === 0) {
    return undefined;
  }
  const parsed = new Date(observedAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
