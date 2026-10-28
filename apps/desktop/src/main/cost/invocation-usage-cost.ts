/**
 * @file invocation-usage-cost.ts
 * @description ISS-7261: price one measured component invocation.
 *
 * `agent_component_invocations.estimated_cost` has existed since FEA-3981 and
 * nothing ever wrote it. This is the costing layer that fills it, through the
 * same `estimateTokenCost` engine every other desktop cost surface uses.
 *
 * It refuses twice, deliberately: corrupt counts withhold the whole telemetry
 * row, and an unpriceable model yields `null`, never `0` — a component that
 * reads as free never gets a second look.
 *
 * ISS-7361: the table tiers PER REQUEST (gpt-5.5 doubles its input rate above
 * 272K prompt tokens), so pricing a folded run as one request charges every
 * round-trip at whatever tier the run's lifetime volume lands in — six
 * invocations came to sum above the session that ran them. When the producer
 * still holds the round-trips, each is priced alone and the prices summed, the
 * shape FEA-3232 already uses for `token_usage`; the fold is priced only when
 * no record survives to the writer.
 */
import { areTokenCountsValid } from "@repo/cost/genai-cost";
import type {
  NormalizedComponentUsage,
  NormalizedTokenRecord,
} from "@repo/lib/harness/types";
import {
  type EstimateTokenCostInput,
  estimateTokenCost,
} from "../../shared/token-cost.js";
import { reportTokenCostPricingMiss } from "./token-cost-pricing-miss.js";

export type InvocationUsageCostInput = {
  usage: NormalizedComponentUsage;
  /**
   * The round-trips `usage` was folded from, when the producer still has them.
   * Absent for producers whose fold happened inside the parser (the Claude
   * skill/command attribution), which therefore still price the fold.
   */
  usageRecords?: readonly NormalizedTokenRecord[];
  /** The invocation's own instant, so historical pricing picks the right rate. */
  invokedAt: string | null;
  sessionId: string;
};

/**
 * Gates PERSISTENCE, not just pricing: a row that fails here is written with no
 * telemetry rather than with counts the engine already refuses to trust.
 */
export function areInvocationUsageCountsValid(
  usage: NormalizedComponentUsage
): boolean {
  return areTokenCountsValid({
    model: usage.model ?? "",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}

/**
 * The USD an invocation's measured tokens cost, or `null` when they cannot be
 * priced: a model id the table does not carry, or — with no records to price
 * one by one — a mixed-model fold. A miss reaches the existing deduplicating
 * pricing-miss monitor rather than nothing.
 */
export function invocationEstimatedCostUsd(
  input: InvocationUsageCostInput
): number | null {
  const perRequest = sumPerRequestCostUsd(input);
  if (perRequest !== undefined) {
    return perRequest;
  }
  return foldedCostUsd(input);
}

/**
 * Σ price(record) over the round-trips `usage` was folded from. `null` when one
 * of them cannot be priced. `undefined` when there is nothing to sum: no
 * records, or records that do not add up to `usage` — the fold then prices as
 * a whole rather than from a different set of turns than the counts it sits
 * beside (FEA-3232's fail-closed rule, applied one layer up).
 */
function sumPerRequestCostUsd(
  input: InvocationUsageCostInput
): number | null | undefined {
  const records = input.usageRecords;
  if (!records || records.length === 0) {
    return undefined;
  }
  if (!recordsReconcileWithUsage(records, input.usage)) {
    return undefined;
  }
  let total = 0;
  for (const record of records) {
    const costInput: EstimateTokenCostInput = {
      model: record.model,
      inputTokens: record.input,
      outputTokens: record.output,
      cacheReadTokens: record.cacheRead,
      cacheWriteTokens: record.cacheWrite,
      ...(record.cacheWriteTtl
        ? { cacheWrite1hTokens: record.cacheWriteTtl.oneH }
        : {}),
      observedAt: record.timestamp,
    };
    const estimate = estimateTokenCost(costInput);
    if (!estimate || estimate.unknownModelFallbackApplied) {
      reportTokenCostPricingMiss(
        costInput,
        "component_invocation",
        input.sessionId
      );
      return null;
    }
    total += estimate.costUsd;
  }
  return total;
}

/**
 * The records are the fold's own source, so their sums equal its counts by
 * construction; a mismatch means a caller paired a fold with someone else's
 * turns, and the only honest price for THOSE counts is the fold's.
 */
function recordsReconcileWithUsage(
  records: readonly NormalizedTokenRecord[],
  usage: NormalizedComponentUsage
): boolean {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWriteOneHour = 0;
  for (const record of records) {
    input += record.input;
    output += record.output;
    cacheRead += record.cacheRead;
    cacheWrite += record.cacheWrite;
    cacheWriteOneHour += record.cacheWriteTtl?.oneH ?? 0;
  }
  return (
    input === usage.inputTokens &&
    output === usage.outputTokens &&
    cacheRead === usage.cacheReadTokens &&
    cacheWrite === usage.cacheWriteTokens &&
    cacheWriteOneHour === (usage.cacheWriteTtl?.oneH ?? 0)
  );
}

/** Price the fold as one request: the only option once the records are gone. */
function foldedCostUsd(input: InvocationUsageCostInput): number | null {
  const { usage } = input;
  if (usage.model === null) {
    return null;
  }
  const costInput = {
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    // FEA-3419: an omitted one-hour count prices the WHOLE cache-write bucket
    // at the five-minute rate, so leaving this off understates the money for
    // any invocation that wrote a one-hour ephemeral cache entry.
    ...(usage.cacheWriteTtl
      ? { cacheWrite1hTokens: usage.cacheWriteTtl.oneH }
      : {}),
    observedAt: input.invokedAt,
  };
  const estimate = estimateTokenCost(costInput);
  // ISS-7762: a model the table cannot price still comes back PRICED, at the
  // Opus-standard fallback tier. Every other desktop cost writer keeps that
  // figure and records its provenance in a `cost_source` column;
  // `agent_component_invocations` has no such column, so a fallback floor here
  // would be indistinguishable from a rate the library confirmed. Unpriced is
  // the honest answer when the provenance cannot ride along.
  if (!estimate || estimate.unknownModelFallbackApplied) {
    reportTokenCostPricingMiss(
      costInput,
      "component_invocation",
      input.sessionId
    );
    return null;
  }
  return estimate.costUsd;
}
