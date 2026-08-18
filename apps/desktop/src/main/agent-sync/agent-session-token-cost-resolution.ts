/**
 * Resolve the per-row token cost and billing mode the sync payload carries.
 *
 * A cost stored at ingest always wins; otherwise the shared pricing table
 * estimates it, and a pricing miss is reported rather than silently emitting a
 * fabricated number. Billing mode follows the same precedence — a stored,
 * definite mode beats best-effort re-detection from the live desktop
 * environment.
 *
 * Extracted verbatim from `agent-session-sync-service.ts` (ISS-4676).
 */
import type { BillingMode } from "../../shared/billing-mode.js";
import { estimateTokenCost } from "../../shared/token-cost.js";
import { resolveBillingMode } from "../cost/billing-mode-detector.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";
import type { SessionRow, TokenUsageRow } from "./agent-session-read-model.js";

export function resolveStoredTokenUsageCostUsd(
  tokenUsage: TokenUsageRow
): number | undefined {
  return tokenUsage.cost_usd_estimated == null
    ? undefined
    : Number(tokenUsage.cost_usd_estimated);
}

export function resolveTokenUsageCostUsd(
  tokenUsage: TokenUsageRow
): number | undefined {
  const storedCostUsd = resolveStoredTokenUsageCostUsd(tokenUsage);
  if (storedCostUsd !== undefined) {
    return storedCostUsd;
  }
  const costInput = {
    model: tokenUsage.model,
    inputTokens: tokenUsage.input_tokens,
    outputTokens: tokenUsage.output_tokens,
    cacheReadTokens: tokenUsage.cache_read_tokens,
    cacheWriteTokens: tokenUsage.cache_write_tokens,
    // FEA-3419: 1h-correct fallback pricing when the caller carried the split.
    ...(tokenUsage.cache_write_1h_tokens == null
      ? {}
      : { cacheWrite1hTokens: Number(tokenUsage.cache_write_1h_tokens) }),
    observedAt: tokenUsage.created_at,
  };
  const estimate = estimateTokenCost(costInput);
  if (!estimate) {
    reportTokenCostPricingMiss(
      costInput,
      "sync_resolver",
      tokenUsage.session_id
    );
    return undefined;
  }
  return estimate.costUsd;
}

/**
 * Resolve a session's billing mode for the sync payload (CLOSEDLOOP FEA-1434).
 * The sidecar importers and the Claude session route stamp the real mode at
 * ingest; this fills the gap for legacy rows (migrated to the default
 * 'unknown') by best-effort detecting from the live desktop environment. A
 * stored, definite mode always wins over re-detection.
 */
export function resolveBillingModeForRow(
  row: Pick<SessionRow, "billing_mode" | "harness"> & { model?: string | null }
): BillingMode {
  return resolveBillingMode({
    billingMode: row.billing_mode,
    harness: row.harness,
    // ISS-5445: forwarded so a legacy NULL/'unknown' row from a bring-your-own-key
    // harness is re-resolved from its MODEL rather than from the harness name.
    // Optional — a caller whose projection omits `model` gets the honest
    // "unknown" instead of a guess.
    model: row.model ?? null,
  });
}
