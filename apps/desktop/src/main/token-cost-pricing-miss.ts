/**
 * @file token-cost-pricing-miss.ts
 * @description Observability seam for unpriced token usage (FEA-1969).
 *
 * The shared token-cost engine (`estimateTokenCost`) returns `undefined`
 * when genai-prices cannot price a model — collapsing the structured
 * not-priced reason. Rather than add logging into that shared, dual-consumed
 * shim, the costing LAYERS call `reportTokenCostPricingMiss` on the miss path.
 * This module owns the one piece of repeated logic (recover the reason, hand
 * off to the deduplicating facade) so the four call sites stay one line each.
 */
import {
  computeTokenCost,
  type EstimateTokenCostInput,
  type TokenCostNotPricedReason,
} from "../shared/token-cost.js";
import { Observability } from "./observability.js";
import type { TokenCostPricingMissSurface } from "./telemetry-protocol.js";

/**
 * Report that a costing layer could not price `input`. Call ONLY on the miss
 * path (when `estimateTokenCost(input)` returned `undefined`). The
 * canonical re-compute that derives the reason is deferred behind a thunk so it
 * runs only for events that survive the facade's dedup gate.
 */
export function reportTokenCostPricingMiss(
  input: EstimateTokenCostInput,
  surface: TokenCostPricingMissSurface,
  sessionId?: string
): void {
  Observability.tokenCostPricingMiss({
    model: input.model ?? "",
    surface,
    sessionId,
    resolveReason: () => resolveNotPricedReason(input),
  });
}

/** Re-run the canonical engine purely to recover the structured reason. */
function resolveNotPricedReason(
  input: EstimateTokenCostInput
): TokenCostNotPricedReason {
  const timestamp = coerceTimestamp(input.observedAt);
  const result = computeTokenCost({
    model: input.model ?? "",
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    ...(timestamp ? { timestamp } : {}),
  });
  // Defensive: callers invoke this only on the miss path, so `reason` is set —
  // fall back to "no_match" if the engine somehow priced it here.
  return result.reason ?? "no_match";
}

function coerceTimestamp(
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
