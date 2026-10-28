/**
 * ISS-5288 — the READ half of the desktop-snapshot import: the SQLite queries
 * that turn a snapshot file into per-session row bundles.
 *
 * Separated from `perf-import-desktop-snapshot-mapping.ts`, which decides what
 * a row BECOMES on the wire. The seam is the column alias: every query here
 * aliases the desktop's snake_case physical columns to the camelCase keys the
 * mapping reads, so the SQL owns "where the value lives" and the mapping owns
 * "what the value means". Keeping them apart also lets the mapping be tested
 * against hand-built bundles with no database at all.
 *
 * Column names are aliased to camelCase in SQL rather than carried as
 * snake_case row keys, per the repo's camelCase-identifier rule.
 */
import { DatabaseSync } from "node:sqlite";

/** One row as `node:sqlite` returns it: keys are the query's own aliases. */
export type SqliteRow = Record<string, unknown>;

/** A snapshot session and every related row the wire payload can carry. */
export type SnapshotSessionBundle = {
  session: SqliteRow;
  agents: SqliteRow[];
  events: SqliteRow[];
  tokenUsage: SqliteRow[];
  tokenEvents: SqliteRow[];
  analytics: SqliteRow | undefined;
  activitySegments: SqliteRow[];
  componentUsage: SqliteRow[];
};

const SESSION_SELECT = `
  SELECT
    id AS "id",
    name AS "name",
    status AS "status",
    cwd AS "cwd",
    model AS "model",
    harness AS "harness",
    billing_mode AS "billingMode",
    repo_full_name AS "repoFullName",
    started_at AS "startedAt",
    updated_at AS "updatedAt",
    ended_at AS "endedAt",
    awaiting_input_since AS "awaitingInputSince",
    metadata AS "metadata",
    data_revision AS "dataRevision",
    ends_with_error AS "endsWithError",
    frustration_raw AS "frustrationRaw",
    frustration_score_version AS "frustrationScoreVersion"
  FROM sessions
`;

/** Open the snapshot READ-ONLY. A perf import must never mutate its source. */
export function openSnapshot(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Every session id in the snapshot, in a stable order so a re-run batches the
 * same sessions together and the summary is comparable across runs.
 */
export function readSnapshotSessionIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT id FROM sessions ORDER BY started_at ASC, id ASC")
    .all() as SqliteRow[];
  return rows.map((row) => String(row.id));
}

/** Load one slice of sessions plus all their related rows, keyed by session. */
export function loadSnapshotBundles(
  db: DatabaseSync,
  sessionIds: string[]
): SnapshotSessionBundle[] {
  const placeholders = sessionIds.map(() => "?").join(", ");
  const sessions = db
    .prepare(`${SESSION_SELECT} WHERE id IN (${placeholders})`)
    .all(...sessionIds) as SqliteRow[];

  const agents = groupBySession(
    db,
    `SELECT session_id AS "sessionId", id AS "id", name AS "name", type AS "type",
            subagent_type AS "subagentType", status AS "status",
            current_tool AS "currentTool", started_at AS "startedAt",
            updated_at AS "updatedAt", ended_at AS "endedAt",
            awaiting_input_since AS "awaitingInputSince",
            parent_agent_id AS "parentAgentId", metadata AS "metadata"
     FROM agents WHERE session_id IN (${placeholders})`,
    sessionIds
  );
  const events = groupBySession(
    db,
    `SELECT session_id AS "sessionId", id AS "id", agent_id AS "agentId",
            event_type AS "eventType", tool_name AS "toolName",
            created_at AS "createdAt"
     FROM events WHERE session_id IN (${placeholders}) ORDER BY created_at ASC`,
    sessionIds
  );
  const tokenUsage = groupBySession(
    db,
    `SELECT session_id AS "sessionId", model AS "model",
            input_tokens AS "inputTokens", output_tokens AS "outputTokens",
            cache_read_tokens AS "cacheReadTokens",
            cache_write_tokens AS "cacheWriteTokens",
            cache_write_5m_tokens AS "cacheWrite5mTokens",
            cache_write_1h_tokens AS "cacheWrite1hTokens",
            baseline_input AS "baselineInput", baseline_output AS "baselineOutput",
            baseline_cache_read AS "baselineCacheRead",
            baseline_cache_write AS "baselineCacheWrite",
            cost_usd_estimated AS "costUsdEstimated"
     FROM token_usage WHERE session_id IN (${placeholders})`,
    sessionIds
  );
  const tokenEvents = groupBySession(
    db,
    `SELECT session_id AS "sessionId", transport_id AS "transportId",
            model AS "model", created_at AS "createdAt",
            input_tokens AS "inputTokens", output_tokens AS "outputTokens",
            cache_read_tokens AS "cacheReadTokens",
            cache_write_tokens AS "cacheWriteTokens",
            cost_usd_estimated AS "costUsdEstimated",
            source_identity AS "sourceIdentity", cost_summary AS "costSummary"
     FROM token_events WHERE session_id IN (${placeholders})
     ORDER BY created_at ASC`,
    sessionIds
  );
  const segments = groupBySession(
    db,
    `SELECT session_id AS "sessionId", phase AS "phase", start_ms AS "startMs",
            end_ms AS "endMs", confidence AS "confidence",
            evidence_layers AS "evidenceLayers", version AS "version",
            work_item_ref AS "workItemRef", subagent_id AS "subagentId"
     FROM session_activity_segments WHERE session_id IN (${placeholders})
     ORDER BY start_ms ASC`,
    sessionIds
  );
  const componentUsage = groupBySession(
    db,
    `SELECT session_id AS "sessionId", component_kind AS "componentKind",
            component_key AS "componentKey",
            agent_component_id AS "externalComponentId", harness AS "harness",
            invocations AS "invocations", error_count AS "errorCount",
            first_invoked_at AS "firstInvokedAt",
            last_invoked_at AS "lastInvokedAt", git_branch AS "gitBranch",
            component_version_hash AS "componentVersionHash"
     FROM agent_component_session_usage WHERE session_id IN (${placeholders})
     ORDER BY session_id ASC, component_kind ASC, component_key ASC,
              git_branch ASC`,
    sessionIds
  );
  const analytics = new Map<string, SqliteRow>();
  const analyticsRows = db
    .prepare(
      `SELECT session_id AS "sessionId", started_at AS "startedAt",
              started_day AS "startedDay", status AS "status",
              harness AS "harness", is_human AS "isHuman",
              human_turns AS "humanTurns", agent_turns AS "agentTurns",
              event_count AS "eventCount", tool_invocations AS "toolInvocations",
              error_events AS "errorEvents", input_tokens AS "inputTokens",
              output_tokens AS "outputTokens",
              cache_read_tokens AS "cacheReadTokens",
              cache_write_tokens AS "cacheWriteTokens", est_cost AS "estCost",
              runtime_ms AS "runtimeMs", updated_at AS "updatedAt"
       FROM session_analytics WHERE session_id IN (${placeholders})`
    )
    .all(...sessionIds) as SqliteRow[];
  for (const row of analyticsRows) {
    analytics.set(String(row.sessionId), row);
  }

  return sessions.map((session) => {
    const id = String(session.id);
    return {
      session,
      agents: agents.get(id) ?? [],
      events: events.get(id) ?? [],
      tokenUsage: tokenUsage.get(id) ?? [],
      tokenEvents: tokenEvents.get(id) ?? [],
      analytics: analytics.get(id),
      activitySegments: segments.get(id) ?? [],
      componentUsage: componentUsage.get(id) ?? [],
    };
  });
}

/** Bucket a related-table result by the `sessionId` alias every query selects. */
function groupBySession(
  db: DatabaseSync,
  sql: string,
  sessionIds: string[]
): Map<string, SqliteRow[]> {
  const grouped = new Map<string, SqliteRow[]>();
  const rows = db.prepare(sql).all(...sessionIds) as SqliteRow[];
  for (const row of rows) {
    const key = String(row.sessionId);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
      continue;
    }
    grouped.set(key, [row]);
  }
  return grouped;
}
