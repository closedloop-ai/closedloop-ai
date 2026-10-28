import { estimateTokenCost } from "../../shared/token-cost.js";
import type { ActivityBucket } from "../agent-sync/agent-session-sync-contract.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";
import { nullableNumber, tokenCountValue } from "./db-helpers.js";
import { addActivityBucketModelCost } from "./session-trace-activity-bucket.js";

/** Fold one token event into a trace bucket using the canonical cost rules. */
export function addTraceTokenEventToBucket(
  bucket: ActivityBucket,
  tokenEvent: {
    model: string;
    created_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cache_write_1h_tokens?: number | null;
    input_cost_usd_estimated: number | null;
    output_cost_usd_estimated: number | null;
    cache_read_cost_usd_estimated: number | null;
    cache_creation_cost_usd_estimated: number | null;
  }
): void {
  const storedInputCost = nullableNumber(tokenEvent.input_cost_usd_estimated);
  const storedOutputCost = nullableNumber(tokenEvent.output_cost_usd_estimated);
  const storedCacheReadCost = nullableNumber(
    tokenEvent.cache_read_cost_usd_estimated
  );
  const storedCacheCreationCost = nullableNumber(
    tokenEvent.cache_creation_cost_usd_estimated
  );
  const inputTokens = tokenCountValue(
    tokenEvent.input_tokens,
    "timeline.input"
  );
  const outputTokens = tokenCountValue(
    tokenEvent.output_tokens,
    "timeline.output"
  );
  const cacheReadTokens = tokenCountValue(
    tokenEvent.cache_read_tokens,
    "timeline.cache_read"
  );
  const cacheWriteTokens = tokenCountValue(
    tokenEvent.cache_write_tokens,
    "timeline.cache_write"
  );
  const fallbackInput =
    storedInputCost == null &&
    storedOutputCost == null &&
    storedCacheReadCost == null &&
    storedCacheCreationCost == null
      ? {
          model: tokenEvent.model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          ...(tokenEvent.cache_write_1h_tokens == null
            ? {}
            : { cacheWrite1hTokens: tokenEvent.cache_write_1h_tokens }),
          observedAt: tokenEvent.created_at,
        }
      : undefined;
  const fallbackCost = fallbackInput
    ? estimateTokenCost(fallbackInput)
    : undefined;
  if (fallbackInput && !fallbackCost) {
    reportTokenCostPricingMiss(fallbackInput, "trace_activity");
  }
  const inputCost = storedInputCost ?? fallbackCost?.inputCostUsd ?? 0;
  const outputCost = storedOutputCost ?? fallbackCost?.outputCostUsd ?? 0;
  const cacheCost =
    (storedCacheReadCost ?? 0) +
    (storedCacheCreationCost ?? 0) +
    (fallbackCost?.cacheReadCostUsd ?? 0) +
    (fallbackCost?.cacheWriteCostUsd ?? 0);
  bucket.cIn += inputCost;
  bucket.cOut += outputCost;
  bucket.cCache += cacheCost;
  addActivityBucketModelCost(bucket, tokenEvent.model, {
    cIn: inputCost,
    cOut: outputCost,
    cCache: cacheCost,
  });
}
