import { InvalidTokenCountError } from "../cost/token-counts.js";
import { SESSION_STARTED_AT_BOUNDS_EXPR } from "./db-constants.js";
import type { DesktopPrismaReader } from "./prisma-client.js";
import {
  invalidCacheWriteTtlSubdivisionSql,
  invalidSessionCostAggregateSql,
  invalidSessionCostOperandSql,
  invalidTokenOperandSql,
  SESSION_TOKEN_OPERANDS,
} from "./session-quality-sql.js";
import type {
  UsageAggregateRows,
  UsageHarnessCountRow,
  UsageModelCountRow,
  UsageRepoCountRow,
  UsageTokenGroupRow,
  UsageUserCountRow,
} from "./session-usage-aggregate.js";

type PackedUsageRows = {
  token_rows: string;
  harness_rows: string;
  model_rows: string;
  user_rows: string;
  repo_rows: string;
  earliest_session_at: string | null;
  latest_session_at: string | null;
  invalid_cost_session_id: string | null;
  invalid_token_session_id: string | null;
};

/** Materialize a narrowed quality cohort once for all five groups and bounds. */
export async function readNarrowedUsageRows(
  reader: DesktopPrismaReader,
  clause: string,
  params: readonly unknown[]
): Promise<UsageAggregateRows> {
  // lexical-timestamp-ok: both bounds fold fixed-width UTC strftime keys.
  const [packed] = await reader.$queryRawUnsafe<PackedUsageRows[]>(
    `WITH cohort AS MATERIALIZED (
      SELECT s.id, s.billing_mode, s.harness, s.model, s.user_id,
        s.cwd, s.repo_full_name, s.started_at FROM sessions s ${clause}
    )
    SELECT
      (SELECT json_group_array(json_object(
        'billing_mode', billing_mode, 'harness', harness, 'model', model,
        'input_tokens', CAST(input_tokens AS TEXT),
        'output_tokens', CAST(output_tokens AS TEXT),
        'cache_read_tokens', CAST(cache_read_tokens AS TEXT),
        'cache_write_tokens', CAST(cache_write_tokens AS TEXT),
        'session_count', session_count,
        'estimated_cost_usd', estimated_cost_usd,
        'invalid_estimated_cost', invalid_estimated_cost,
        'unpriced_input_tokens', CAST(unpriced_input_tokens AS TEXT),
        'unpriced_output_tokens', CAST(unpriced_output_tokens AS TEXT),
        'unpriced_cache_read_tokens', CAST(unpriced_cache_read_tokens AS TEXT),
        'unpriced_cache_write_tokens', CAST(unpriced_cache_write_tokens AS TEXT),
        'unpriced_cache_write_1h_tokens', CAST(unpriced_cache_write_1h_tokens AS TEXT)
      )) FROM (
        SELECT s.billing_mode, s.harness, t.model,
          SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)) AS input_tokens,
          SUM(COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)) AS output_tokens,
          SUM(COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0)) AS cache_read_tokens,
          SUM(COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0)) AS cache_write_tokens,
          COUNT(DISTINCT t.session_id) AS session_count,
          SUM(t.cost_usd_estimated) AS estimated_cost_usd,
          ${invalidSessionCostAggregateSql("t.cost_usd_estimated")} AS invalid_estimated_cost,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0) ELSE 0 END) AS unpriced_input_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0) ELSE 0 END) AS unpriced_output_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0) ELSE 0 END) AS unpriced_cache_read_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0) ELSE 0 END) AS unpriced_cache_write_tokens,
          SUM(CASE WHEN t.cost_usd_estimated IS NULL THEN COALESCE(t.cache_write_1h_tokens, 0) ELSE 0 END) AS unpriced_cache_write_1h_tokens
        FROM cohort s JOIN token_usage t ON t.session_id = s.id
        GROUP BY s.billing_mode, s.harness, t.model
        ORDER BY s.harness, t.model, s.billing_mode
      )) AS token_rows,
      (SELECT json_group_array(json_object('harness', harness, 'session_count', session_count)) FROM (
        SELECT s.harness, COUNT(*) AS session_count FROM cohort s GROUP BY s.harness ORDER BY s.harness
      )) AS harness_rows,
      (SELECT json_group_array(json_object('model', model, 'session_count', session_count)) FROM (
        SELECT s.model, COUNT(*) AS session_count FROM cohort s GROUP BY s.model ORDER BY s.model
      )) AS model_rows,
      (SELECT json_group_array(json_object('user_id', user_id, 'session_count', session_count)) FROM (
        SELECT s.user_id, COUNT(*) AS session_count FROM cohort s GROUP BY s.user_id ORDER BY s.user_id
      )) AS user_rows,
      (SELECT json_group_array(json_object('cwd', cwd, 'repo_full_name', repo_full_name, 'session_count', session_count)) FROM (
        SELECT s.cwd, s.repo_full_name, COUNT(*) AS session_count
        FROM cohort s GROUP BY s.cwd, s.repo_full_name ORDER BY s.cwd, s.repo_full_name
      )) AS repo_rows,
      (SELECT MIN(${SESSION_STARTED_AT_BOUNDS_EXPR}) FROM cohort s) AS earliest_session_at,
      (SELECT MAX(${SESSION_STARTED_AT_BOUNDS_EXPR}) FROM cohort s) AS latest_session_at,
      (SELECT t.session_id FROM cohort s JOIN token_usage t ON t.session_id = s.id
        WHERE ${SESSION_TOKEN_OPERANDS.map(invalidTokenOperandSql).join(" OR ")}
          OR ${invalidCacheWriteTtlSubdivisionSql()}
        LIMIT 1) AS invalid_token_session_id,
      (SELECT t.session_id FROM cohort s JOIN token_usage t ON t.session_id = s.id
        WHERE ${invalidSessionCostOperandSql()}
        LIMIT 1) AS invalid_cost_session_id`,
    ...params
  );
  if (!packed) {
    throw new Error("Missing narrowed Sessions usage aggregate");
  }
  if (packed.invalid_token_session_id) {
    throw new InvalidTokenCountError(
      `session ${packed.invalid_token_session_id} token_usage`
    );
  }
  if (packed.invalid_cost_session_id) {
    throw new Error(
      `Invalid persisted cost in session ${packed.invalid_cost_session_id}`
    );
  }
  return {
    tokenRows: JSON.parse(packed.token_rows) as UsageTokenGroupRow[],
    harnessRows: JSON.parse(packed.harness_rows) as UsageHarnessCountRow[],
    primaryModelRows: JSON.parse(packed.model_rows) as UsageModelCountRow[],
    userRows: JSON.parse(packed.user_rows) as UsageUserCountRow[],
    repoRows: JSON.parse(packed.repo_rows) as UsageRepoCountRow[],
    boundsRow: {
      earliest_session_at: packed.earliest_session_at,
      latest_session_at: packed.latest_session_at,
    },
  };
}
