/**
 * @file session-detail-mappers.ts
 * @description Row-selection, grouping, and mapping helpers for the desktop
 * session-detail reads: the generic id-list `SELECT` and per-session grouping
 * primitives, the shared detail CTE fragment, and the raw-row → domain-row
 * mappers (session, token-usage, and the aggregate session-with-agents list).
 * Extracted verbatim from `sqlite.ts`; pure aside from the reader handle passed
 * into `selectRowsByIds`, depending only on shared contract types and helpers.
 */
import type {
  SessionRow,
  SessionWithAgents,
} from "../../shared/agent-db-contract.js";
import type { TokenUsageRow } from "../agent-dashboard-db-types.js";
import { resolveTokenUsageCostUsd } from "../agent-session-sync-service.js";
import { tokenCountValue } from "./db-helpers.js";
import type { DesktopPrismaReadClient } from "./prisma-client.js";

function selectRowsByIds<T extends Record<string, unknown>>(
  reader: DesktopPrismaReadClient,
  sql: string,
  ids: string[]
): Promise<T[]> {
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  return reader.$queryRawUnsafe<T[]>(
    sql.replaceAll("__IDS__", placeholders),
    ...ids
  );
}

function groupRowsBySessionId<T extends { session_id: string }>(
  rows: T[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.session_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.session_id, [row]);
    }
  }
  return grouped;
}

function sessionDetailsCtes(): string {
  return `
    WITH agent_counts AS (
      SELECT session_id, COUNT(*) as agent_count
      FROM agents
      GROUP BY session_id
    ),
    event_counts AS (
      SELECT session_id, COUNT(*) as event_count
      FROM events
      GROUP BY session_id
    ),
    token_totals AS (
      SELECT
        session_id,
        COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens
      FROM token_usage
      GROUP BY session_id
    )
  `;
}

function toSessionRow(
  raw: Record<string, unknown> | undefined
): SessionRow | undefined {
  if (!raw) {
    return undefined;
  }
  return {
    id: raw.id as string,
    name: (raw.name as string) ?? null,
    status: raw.status as string,
    cwd: (raw.cwd as string) ?? null,
    model: (raw.model as string) ?? null,
    startedAt: (raw.started_at as string) ?? null,
    updatedAt: (raw.updated_at as string) ?? null,
    endedAt: (raw.ended_at as string) ?? null,
    awaitingInputSince: (raw.awaiting_input_since as string) ?? null,
    metadata: (raw.metadata as string) ?? null,
    harness: (raw.harness as string) ?? null,
    billingMode: (raw.billing_mode as string) ?? null,
    userId: (raw.user_id as string) ?? null,
    organizationId: (raw.organization_id as string) ?? null,
  };
}

function toTokenUsageRow(raw: Record<string, unknown>): TokenUsageRow {
  const inputTokens = tokenCountValue(
    raw.input_tokens,
    "token_usage.input_tokens"
  );
  const outputTokens = tokenCountValue(
    raw.output_tokens,
    "token_usage.output_tokens"
  );
  const cacheReadTokens = tokenCountValue(
    raw.cache_read_tokens,
    "token_usage.cache_read_tokens"
  );
  const cacheWriteTokens = tokenCountValue(
    raw.cache_write_tokens,
    "token_usage.cache_write_tokens"
  );
  const estimatedCostUsd = resolveTokenUsageCostUsd({
    session_id: raw.session_id as string,
    model: raw.model as string,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    created_at: (raw.created_at as string) ?? null,
    cost_usd_estimated: (raw.cost_usd_estimated as number) ?? null,
  });
  return {
    sessionId: raw.session_id as string,
    model: raw.model as string,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

// Maps the detail-read CTE rows (session columns + aggregate counts) to
// SessionWithAgents, coercing the COUNT/SUM columns (the raw path may surface
// them as bigint) at the Number()/token() boundary.
function detailRowsToList(
  raws: Record<string, unknown>[]
): SessionWithAgents[] {
  return raws.map((raw) => {
    const base = toSessionRow(raw)!;
    return {
      ...base,
      agentCount: Number(raw.agent_count ?? 0),
      eventCount: Number(raw.event_count ?? 0),
      totalTokens: tokenCountValue(raw.total_tokens, "session.total_tokens"),
    };
  });
}

export {
  detailRowsToList,
  groupRowsBySessionId,
  selectRowsByIds,
  sessionDetailsCtes,
  toSessionRow,
  toTokenUsageRow,
};
