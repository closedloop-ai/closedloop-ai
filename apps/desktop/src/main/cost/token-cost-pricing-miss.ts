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
  coerceObservedAt,
  computeTokenCost,
  type EstimateTokenCostInput,
  type TokenCostNotPricedReason,
} from "../../shared/token-cost.js";
import { Observability } from "../telemetry/observability.js";
import type { TokenCostPricingMissSurface } from "../telemetry/telemetry-protocol.js";

/**
 * Report that a costing layer could not price `input`. Two admissible callers:
 * the miss path (`estimateTokenCost(input)` returned `undefined`), and — since
 * ISS-7261 — a layer whose SINK cannot record pricing provenance, for which an
 * `unknownModelFallbackApplied` estimate is not a usable price either. Every
 * caller with a `cost_source` column keeps the fallback figure and reports only
 * a true miss. The canonical re-compute that derives the reason is deferred
 * behind a thunk so it runs only for events that survive the dedup gate.
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
  const timestamp = coerceObservedAt(input.observedAt);
  const result = computeTokenCost({
    model: input.model ?? "",
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    ...(timestamp ? { timestamp } : {}),
  });
  // The library-pure engine leaves `reason` set for both admissible callers: a
  // true miss, and the fallback-tier case, which is `no_match` here because the
  // Opus-standard recovery lives in the parity layer, not in this engine.
  return result.reason ?? "no_match";
}
