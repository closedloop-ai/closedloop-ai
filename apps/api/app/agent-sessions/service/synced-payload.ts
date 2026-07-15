import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { z } from "zod";
import {
  syncedAgentSessionAgentSchema,
  syncedAgentSessionEventSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { parseJsonObject } from "@/lib/json-schema";
import { decimalToNumber, tokenCountToNumber } from "./coercion";
import type { AgentSessionDetailRecord, SessionTotals } from "./records";

export function getLoopApiKeySource(value: unknown): string | null {
  const metadata = parseJsonObject(value);
  return typeof metadata?.apiKeySource === "string"
    ? metadata.apiKeySource
    : null;
}

// Desktop billing modes covered by a flat subscription/seat rather than
// per-token API spend. Mirrors SUBSCRIPTION_MODES in the desktop's canonical
// billing-mode engine (apps/desktop/src/shared/billing-mode.ts); kept as an
// explicit allow-list so any unrecognized/legacy value falls through to the API
// bucket rather than being misreported as subscription. Used to attribute
// DESKTOP_SYNC session cost, which has no source Loop to classify by.
//
// FEA-3104: exported so the parity test
// (../subscription-billing-mode-parity.test.ts) can assert this set stays
// exactly equal to the desktop canonical SUBSCRIPTION_MODES. The binding
// lives in that test only — this app never imports the desktop module at
// runtime, so nothing here touches the API or desktop-main boot graph.
export const SUBSCRIPTION_BILLING_MODES: ReadonlySet<string> = new Set([
  "subscription_unknown",
  "pro",
  "max_5x",
  "max_20x",
  "codex_subscription",
  "cursor_pro",
  "copilot_seat",
]);

export function isSubscriptionBillingMode(value: unknown): boolean {
  return typeof value === "string" && SUBSCRIPTION_BILLING_MODES.has(value);
}

export function toSyncedAgents(value: unknown): SyncedAgentSessionAgent[] {
  const parsed = z.array(syncedAgentSessionAgentSchema).safeParse(value);
  return parsed.success ? (parsed.data as SyncedAgentSessionAgent[]) : [];
}

export function toSyncedEvents(value: unknown): SyncedAgentSessionEvent[] {
  const parsed = z.array(syncedAgentSessionEventSchema).safeParse(value);
  return parsed.success ? (parsed.data as SyncedAgentSessionEvent[]) : [];
}

export function toTokenUsageBreakdown(
  rows: AgentSessionDetailRecord["tokenUsageByModel"]
): SyncedAgentSessionTokenUsage[] {
  return rows.map((row) => ({
    model: row.model,
    inputTokens: tokenCountToNumber(row.inputTokens),
    outputTokens: tokenCountToNumber(row.outputTokens),
    cacheReadTokens: tokenCountToNumber(row.cacheReadTokens),
    cacheWriteTokens: tokenCountToNumber(row.cacheWriteTokens),
    estimatedCostUsd: decimalToNumber(row.estimatedCost),
  }));
}

export function normalizeTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SyncedAgentSessionTokenUsage[] {
  const byModel = new Map<string, SyncedAgentSessionTokenUsage>();

  for (const row of rows) {
    const existing = byModel.get(row.model);
    if (!existing) {
      byModel.set(row.model, {
        ...row,
        estimatedCostUsd: row.estimatedCostUsd ?? 0,
      });
      continue;
    }

    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    existing.cacheReadTokens += row.cacheReadTokens;
    existing.cacheWriteTokens += row.cacheWriteTokens;
    existing.estimatedCostUsd =
      (existing.estimatedCostUsd ?? 0) + (row.estimatedCostUsd ?? 0);
  }

  return [...byModel.values()];
}

export function toAttribution(
  session: Pick<
    AgentSessionDetailRecord,
    | "repositoryFullName"
    | "worktreePath"
    | "sourceArtifactId"
    | "sourceLoopId"
    | "baseBranch"
  >
): SyncedAgentSessionAttribution | null {
  const attribution: SyncedAgentSessionAttribution = {
    repositoryFullName: session.repositoryFullName,
    worktreePath: session.worktreePath,
    sourceArtifactId: session.sourceArtifactId,
    sourceLoopId: session.sourceLoopId,
    baseBranch: session.baseBranch,
  };
  return Object.values(attribution).some((value) => value != null)
    ? attribution
    : null;
}

export function sumTokenUsage(
  rows: readonly SyncedAgentSessionTokenUsage[]
): SessionTotals {
  return rows.reduce<SessionTotals>(
    (totals, row) => ({
      inputTokens: totals.inputTokens + row.inputTokens,
      outputTokens: totals.outputTokens + row.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + row.cacheWriteTokens,
      estimatedCost: totals.estimatedCost + (row.estimatedCostUsd ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    }
  );
}
