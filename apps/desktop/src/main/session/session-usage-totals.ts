/**
 * Per-session token totals and the usage-rollup bucket primitives they feed.
 *
 * #4150: extracted from `shared-agent-sessions-api.ts` (a shrink-only
 * grandfathered file) so the token-total derivation lives in one leaf module.
 * This module is deliberately dependency-free of its former host: the host and
 * `shared-agent-sessions-usage-summary.ts` both import FROM here, never the
 * other way round.
 */
import {
  isSubstantiveSession,
  type SessionSubstantiveCounts,
} from "@repo/api/src/agent-session-filters";
import {
  type BillingLedger,
  billingLedger,
  normalizeBillingMode,
} from "../../shared/billing-mode.js";
import {
  type SharedAgentSessionHarnessBreakdown,
  type SharedAgentSessionUsageByModel,
  UNKNOWN_HARNESS_BUCKET,
} from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";

export type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export function sumTokenUsage(session: SyncedAgentSession): SessionTotals {
  return session.tokenUsageByModel.reduce<SessionTotals>((totals, usage) => {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.estimatedCost += usage.estimatedCostUsd ?? 0;
    return totals;
  }, zeroTotals());
}

export function addTotals(target: SessionTotals, next: SessionTotals): void {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.cacheReadTokens += next.cacheReadTokens;
  target.cacheWriteTokens += next.cacheWriteTokens;
  target.estimatedCost += next.estimatedCost;
}

export function zeroTotals(): SessionTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
}

export function countToolUseEvents(
  events: SyncedAgentSession["events"]
): number {
  return events.filter((event) => Boolean(event.toolName)).length;
}

/**
 * ISS-4481: the session's substantive-work counts (turns/tokens/tool-uses),
 * derived from the hydrated session exactly as `mapListItem` renders them —
 * `session.turns`, the summed per-model token usage (`sumTokenUsage`), and the
 * tool-use event count (`countToolUseEvents`). Shared by the Idle badge
 * (`sessionIsSubstantive`) and the Cost filter's numeric-vs-unknown gate
 * (`matchesLocalCostBucketFilter`) so both classify a session's work identically.
 */
export function localSubstantiveCounts(
  session: SyncedAgentSession
): SessionSubstantiveCounts {
  const totals = sumTokenUsage(session);
  return {
    turns: session.turns ?? null,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    toolUseCount: countToolUseEvents(session.events),
  };
}

/**
 * FEA-3284: whether a local session did substantive work, using the shared
 * `isSubstantiveSession` SSOT (`@repo/api/src/agent-session-filters`) — the SAME
 * predicate the cloud SQL twin encodes. The desktop `sessions` table stores no
 * turn/token/tool columns, so the signals are derived from the hydrated session
 * exactly as `mapListItem` renders them: `session.turns`, the summed per-model
 * token usage (`sumTokenUsage`), and the tool-use event count
 * (`countToolUseEvents`). Keeping the derivation identical to the row guarantees
 * a session buckets as idle vs substantive the same way on desktop, cloud, and
 * the shared UI.
 */
export function sessionIsSubstantive(session: SyncedAgentSession): boolean {
  return isSubstantiveSession(localSubstantiveCounts(session));
}

export function addSessionToHarnessBreakdown(
  byHarness: Map<
    string,
    SharedAgentSessionHarnessBreakdown & { sessionIds: Set<string> }
  >,
  session: SyncedAgentSession,
  totals: SessionTotals
): void {
  const harness = session.harness ?? UNKNOWN_HARNESS_BUCKET;
  const summary = byHarness.get(harness) ?? {
    harness,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    sessionIds: new Set<string>(),
  };
  summary.sessionIds.add(session.externalSessionId);
  summary.sessionCount = summary.sessionIds.size;
  summary.inputTokens += totals.inputTokens;
  summary.outputTokens += totals.outputTokens;
  summary.cacheReadTokens += totals.cacheReadTokens;
  summary.cacheWriteTokens += totals.cacheWriteTokens;
  summary.estimatedCost += totals.estimatedCost;
  byHarness.set(harness, summary);
}

export function getOrCreateModelSummary(
  byModel: Map<
    string,
    SharedAgentSessionUsageByModel & { sessionIds: Set<string> }
  >,
  model: string
): SharedAgentSessionUsageByModel & { sessionIds: Set<string> } {
  const existing = byModel.get(model);
  if (existing) {
    return existing;
  }
  const created = {
    model,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    sessionIds: new Set<string>(),
  };
  byModel.set(model, created);
  return created;
}

export function stripSessionIds<
  T extends { sessionIds: Set<string>; sessionCount: number },
>(value: T): Omit<T, "sessionIds"> {
  value.sessionCount = value.sessionIds.size;
  const { sessionIds: _sessionIds, ...rest } = value;
  return rest;
}

export function getSessionLedger(session: SyncedAgentSession): BillingLedger {
  return billingLedger(normalizeBillingMode(session.billingMode));
}
