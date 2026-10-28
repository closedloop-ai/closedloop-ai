import type { BillingMode } from "../../shared/billing-mode.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import { resolveTokenUsageCostUsd } from "../agent-sync/agent-session-token-cost-resolution.js";
import { addStorageTokenCounts } from "../cost/token-counts.js";
import { localTimeZone, tokenCountValue } from "./db-helpers.js";
import type { SqliteSessionRow, SqliteTokenUsageRow } from "./db-row-types.js";
import type { SessionListTraceProjection } from "./session-list-trace-projection.js";
import { componentInvocationCountPatch } from "./sync-source-session-patches.js";
import {
  sqliteFlagToNullableBoolean,
  toSyncedSessionHead,
} from "./sync-source-session-rows.js";

/** Map compact persisted facts into the canonical in-memory list input. */
export function mapSessionListFacts(input: {
  row: SqliteSessionRow;
  projection: SessionListTraceProjection;
  tokenRows: readonly SqliteTokenUsageRow[];
  billingMode: BillingMode;
  invocationCount: number;
  attribution: SyncedAgentSession["attribution"];
}): SyncedAgentSession {
  const row = input.row;
  return {
    ...toSyncedSessionHead(row),
    harness: row.harness,
    billingMode: input.billingMode,
    cwd: row.cwd,
    model: row.model,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lastActivityAt: input.projection.lastActivityAt,
    endedAt: row.ended_at,
    awaitingInputSince: row.awaiting_input_since,
    endsWithError: sqliteFlagToNullableBoolean(row.ends_with_error),
    metadata: null,
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    deviceTimeZone: localTimeZone(),
    dataRevision: row.data_revision,
    ...componentInvocationCountPatch(input.invocationCount),
    listAgentCount: input.projection.agentCount,
    listToolUseCount: input.projection.toolUseCount,
    listErrorCount: input.projection.errorCount,
    ...(input.attribution ? { attribution: input.attribution } : {}),
    ...input.projection.fields,
    agents: [],
    events: [],
    tokenUsageByModel: input.tokenRows.map(mapListTokenUsage),
  };
}

function mapListTokenUsage(row: SqliteTokenUsageRow) {
  const inputTokens = addStorageTokenCounts(
    row.input_tokens,
    row.baseline_input,
    "list.input"
  );
  const outputTokens = addStorageTokenCounts(
    row.output_tokens,
    row.baseline_output,
    "list.output"
  );
  const cacheReadTokens = addStorageTokenCounts(
    row.cache_read_tokens,
    row.baseline_cache_read,
    "list.cache_read"
  );
  const cacheWriteTokens = addStorageTokenCounts(
    row.cache_write_tokens,
    row.baseline_cache_write,
    "list.cache_write"
  );
  const cacheWrite5mTokens = nullableTokenCount(
    row.cache_write_5m_tokens,
    "list.cache_write_5m"
  );
  const cacheWrite1hTokens = nullableTokenCount(
    row.cache_write_1h_tokens,
    "list.cache_write_1h"
  );
  const estimatedCostUsd = resolveTokenUsageCostUsd({
    ...row,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_write_1h_tokens: cacheWrite1hTokens,
  });
  return {
    model: row.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(cacheWrite5mTokens === null && cacheWrite1hTokens === null
      ? {}
      : { cacheWrite5mTokens, cacheWrite1hTokens }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

function nullableTokenCount(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : tokenCountValue(value, field);
}
