import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionAttribution,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import { z } from "zod";
import {
  syncedAgentSessionAgentSchema,
  syncedAgentSessionEventSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { parseJsonObject } from "@/lib/json-schema";
import { toNumber } from "@/lib/prisma-number";
import type { AgentSessionDetailRecord, SessionTotals } from "./records";

export function getLoopApiKeySource(value: unknown): string | null {
  const metadata = parseJsonObject(value);
  return typeof metadata?.apiKeySource === "string"
    ? metadata.apiKeySource
    : null;
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
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    cacheReadTokens: toNumber(row.cacheReadTokens),
    cacheWriteTokens: toNumber(row.cacheWriteTokens),
    // FEA-3419: typed TTL subdivision; null = never reported (absent).
    cacheWrite5mTokens:
      row.cacheWrite5mTokens == null ? null : toNumber(row.cacheWrite5mTokens),
    cacheWrite1hTokens:
      row.cacheWrite1hTokens == null ? null : toNumber(row.cacheWrite1hTokens),
    estimatedCostUsd: toNumber(row.estimatedCost),
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
    // FEA-3419: the split is present iff either side reported one (absent rows
    // contribute 0 — their cache writes stay in the unclassified residual).
    if (row.cacheWrite1hTokens != null || existing.cacheWrite1hTokens != null) {
      existing.cacheWrite5mTokens =
        (existing.cacheWrite5mTokens ?? 0) + (row.cacheWrite5mTokens ?? 0);
      existing.cacheWrite1hTokens =
        (existing.cacheWrite1hTokens ?? 0) + (row.cacheWrite1hTokens ?? 0);
    }
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

/**
 * ISS-5075: project the detail's raw event rows, honoring the read cap.
 *
 * The select reads one row PAST {@link SESSION_DETAIL_EVENT_MAX_ROWS} so a read
 * that HIT the ceiling is detectable. This bounds the served set back to the cap
 * — a stable chronological PREFIX, since that select orders deterministically —
 * and reports whether it did. Reading the SSOT constant here (rather than taking
 * it as an argument) is what keeps the `take` and this bound from drifting apart.
 *
 * `truncation` is returned SPREAD-SHAPED (`{}` when the stream is complete) for
 * two reasons: the caller splats it, so `eventsTruncated` stays genuinely OMITTED
 * rather than serialized as a present falsy value (absence is the contract's only
 * encoding of "complete"), and the branch stays out of `findSessionDetail`, which
 * sits in a grandfathered module already at the cognitive-complexity ceiling.
 */
export function toBoundedDetailEvents(
  rows: AgentSessionDetailRecord["events"]
): {
  events: SyncedAgentSessionEvent[];
  truncation: { eventsTruncated?: true };
} {
  // `slice` on an under-cap array is just a copy, so the bounded path needs no
  // branch — the rows are re-mapped into a new array either way. The per-callback
  // annotation keeps excess-property checking on the served event shape, so a
  // later edit can't quietly add a desktop-local-only field to the cloud lane.
  const events = rows.slice(0, SESSION_DETAIL_EVENT_MAX_ROWS).map(
    (row): SyncedAgentSessionEvent => ({
      externalEventId: row.externalEventId,
      agentExternalId: row.agentExternalId,
      eventType: row.eventType,
      toolName: row.toolName,
      createdAt: row.eventCreatedAt.toISOString(),
    })
  );
  return {
    events,
    truncation:
      rows.length > SESSION_DETAIL_EVENT_MAX_ROWS
        ? { eventsTruncated: true }
        : {},
  };
}
