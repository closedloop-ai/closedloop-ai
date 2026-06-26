// biome-ignore-all lint/performance/noBarrelFile: intentional SSOT re-export shim — preserves the `apps/desktop/src/shared/token-cost.ts` import path (and the parity test) while the engine lives in @closedloop-ai/loops-api/genai-cost (FEA-1718 / Q-F).
import { computeTokenCost as computeCanonicalTokenCost } from "@closedloop-ai/loops-api/genai-cost";

/**
 * @file token-cost.ts
 * @description Compatibility wrapper around the canonical token-cost engine,
 * now owned by `@closedloop-ai/loops-api/genai-cost` (FEA-1718 / Q-F) so that
 * `apps/api` (Session re-pricing) and `apps/desktop` (synced-session costing)
 * share ONE genai-prices costing source — no twin to keep in parity.
 *
 * Desktop importers and the parity test (`test/token-cost.test.ts`) continue to
 * resolve the engine here; the parity test remains the SSOT guard, validating
 * the shared engine against `@pydantic/genai-prices`' own `extractUsage`.
 */

export {
  buildUsage,
  computeTokenCost,
  type TokenCostInput,
  TokenCostNotPricedReason,
  type TokenCostResult,
} from "@closedloop-ai/loops-api/genai-cost";

export type EstimateTokenCostInput = {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cacheReadTokens: number | null | undefined;
  cacheWriteTokens: number | null | undefined;
  observedAt?: Date | string | null | undefined;
};

export type EstimateTokenCostResult = {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCostUsd: number;
};

export function estimateTokenCost(
  input: EstimateTokenCostInput
): EstimateTokenCostResult | undefined {
  const observedAt = coerceObservedAt(input.observedAt);
  const result = computeCanonicalTokenCost({
    model: input.model ?? "",
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    ...(observedAt ? { timestamp: observedAt } : {}),
  });
  if (!result.priced || result.costUsd == null) {
    return undefined;
  }
  const inputCostUsd = result.inputCostUsd ?? 0;
  const outputCostUsd = result.outputCostUsd ?? 0;
  return {
    costUsd: result.costUsd,
    inputCostUsd,
    outputCostUsd,
    cacheCostUsd: Math.max(0, result.costUsd - inputCostUsd - outputCostUsd),
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
