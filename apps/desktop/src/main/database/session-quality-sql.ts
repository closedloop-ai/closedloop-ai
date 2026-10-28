import { POSTGRES_INT4_MAX } from "@closedloop-ai/loops-api/column-limits";

/** Every persisted token operand consumed by list quality and usage folding. */
export const SESSION_TOKEN_OPERANDS = [
  "input_tokens",
  "baseline_input",
  "output_tokens",
  "baseline_output",
  "cache_read_tokens",
  "baseline_cache_read",
  "cache_write_tokens",
  "baseline_cache_write",
  "cache_write_1h_tokens",
] as const;

export const SESSION_TURN_OPERANDS = [
  "userMessages",
  "assistantMessages",
] as const;

/** SQLite twin of the local list's turn/token/tool/invocation quality gate. */
export function sessionQualitySqlPredicate(quality: unknown): string | null {
  if (quality !== "substantive" && quality !== "idle") {
    return null;
  }
  const userTurns = sessionTurnOperandSql("userMessages");
  const assistantTurns = sessionTurnOperandSql("assistantMessages");
  const turns = `(CASE WHEN json_valid(s.metadata) THEN (${userTurns} + ${assistantTurns}) ELSE NULL END)`;
  const substantive = `(
    COALESCE(${turns} > 0 AND ${turns} <= ${POSTGRES_INT4_MAX}, 0)
    OR EXISTS (
      SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND (
        ${SESSION_TOKEN_OPERANDS.map((column) => `${tokenOperandSql(column)} > 0 OR ${invalidTokenOperandSql(column)}`).join(" OR ")}
      )
    )
    OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.tool_name IS NOT NULL AND e.tool_name <> '')
    OR EXISTS (SELECT 1 FROM agent_component_invocations i WHERE i.session_id = s.id)
  )`;
  return quality === "substantive" ? substantive : `NOT ${substantive}`;
}

export function sessionTurnOperandSql(
  key: (typeof SESSION_TURN_OPERANDS)[number]
): string {
  const jsonPath = `'$.${key}'`;
  const value = `json_extract(s.metadata, ${jsonPath})`;
  const kind = `json_type(s.metadata, ${jsonPath})`;
  return `(CASE WHEN ${kind} IS NULL THEN 0 WHEN ${kind} IN ('integer', 'real') AND ${value} >= 0 AND ${value} <= ${POSTGRES_INT4_MAX} AND ${value} = CAST(${value} AS INTEGER) THEN ${value} ELSE NULL END)`;
}

export function invalidSessionTurnOperandSql(
  key: (typeof SESSION_TURN_OPERANDS)[number]
): string {
  const path = `'$.${key}'`;
  const kind = `json_type(s.metadata, ${path})`;
  return `(${kind} IS NOT NULL AND ${sessionTurnOperandSql(key)} IS NULL)`;
}

function tokenOperandSql(column: string): string {
  return `(CASE WHEN ${validTokenOperandSql(column)} THEN COALESCE(t.${column}, 0) ELSE NULL END)`;
}

export function invalidTokenOperandSql(column: string): string {
  return `NOT ${validTokenOperandSql(column)}`;
}

/** Reject a reported one-hour cache-write subdivision larger than its effective total. */
export function invalidCacheWriteTtlSubdivisionSql(): string {
  return "(COALESCE(t.cache_write_1h_tokens, 0) > COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0))";
}

/** Reject a present stored cost unless SQLite can prove it is non-negative and finite. */
export function invalidSessionCostOperandSql(): string {
  return `(t.cost_usd_estimated IS NOT NULL AND NOT (
    typeof(t.cost_usd_estimated) IN ('integer', 'real')
    AND t.cost_usd_estimated >= 0
    AND t.cost_usd_estimated < 9e999
  ))`;
}

/** Detect a grouped cost whose SQLite total overflowed the finite number domain. */
export function invalidSessionCostAggregateSql(column: string): string {
  return `(COUNT(${column}) > 0 AND (
    SUM(${column}) IS NULL
    OR NOT (SUM(${column}) >= 0 AND SUM(${column}) < 9e999)
  ))`;
}

function validTokenOperandSql(column: string): string {
  return `(typeof(COALESCE(t.${column}, 0)) = 'integer' AND COALESCE(t.${column}, 0) >= 0 AND COALESCE(t.${column}, 0) <= ${Number.MAX_SAFE_INTEGER})`;
}
