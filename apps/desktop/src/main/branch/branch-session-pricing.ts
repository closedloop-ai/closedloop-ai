import { estimateTokenCost } from "../../shared/token-cost.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";

/** Price captured session usage, preferring its authoritative stored costs. */
export function priceSyncedBranchSession(
  session: SyncedAgentSession
): number | null {
  let total = 0;
  let anyPriced = false;
  for (const usage of session.tokenUsageByModel) {
    if (usage.estimatedCostUsd != null) {
      total += usage.estimatedCostUsd;
      anyPriced = true;
      continue;
    }
    const costInput = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.cacheWrite1hTokens == null
        ? {}
        : { cacheWrite1hTokens: usage.cacheWrite1hTokens }),
      observedAt: session.startedAt,
    };
    const estimate = estimateTokenCost(costInput);
    if (estimate) {
      total += estimate.costUsd;
      anyPriced = true;
    } else {
      reportTokenCostPricingMiss(
        costInput,
        "synced_session",
        session.externalSessionId
      );
    }
  }
  return anyPriced ? total : null;
}
