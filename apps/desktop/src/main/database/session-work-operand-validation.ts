import { InvalidTokenCountError } from "../cost/token-counts.js";
import type { DesktopPrismaReader } from "./prisma-client.js";
import {
  invalidCacheWriteTtlSubdivisionSql,
  invalidSessionCostOperandSql,
  invalidSessionTurnOperandSql,
  invalidTokenOperandSql,
  SESSION_TOKEN_OPERANDS,
  SESSION_TURN_OPERANDS,
} from "./session-quality-sql.js";

/** Reject corrupt persisted work operands before any sum, quality classification or compact page is exposed. */
export async function assertValidSessionWorkOperands(
  reader: DesktopPrismaReader,
  clause: string,
  params: readonly unknown[]
): Promise<void> {
  const invalidTurns = `CASE WHEN s.metadata IS NULL OR s.metadata = '' THEN 0 WHEN NOT json_valid(s.metadata) THEN 1 ELSE (${SESSION_TURN_OPERANDS.map(invalidSessionTurnOperandSql).join(" OR ")}) END`;
  const invalidTokens = `EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND (${SESSION_TOKEN_OPERANDS.map(invalidTokenOperandSql).join(" OR ")}))`;
  const invalidCacheWriteTtl = `EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND ${invalidCacheWriteTtlSubdivisionSql()})`;
  const invalidCosts = `EXISTS (SELECT 1 FROM token_usage t WHERE t.session_id = s.id AND ${invalidSessionCostOperandSql()})`;
  const [row] = await reader.$queryRawUnsafe<
    {
      id: string;
      invalid_cost: number | bigint;
      invalid_token: number | bigint;
      invalid_turn: number | bigint;
    }[]
  >(
    `SELECT s.id,
      ${invalidCosts} AS invalid_cost,
      (${invalidTokens} OR ${invalidCacheWriteTtl}) AS invalid_token,
      ${invalidTurns} AS invalid_turn
    FROM sessions s ${clause}
    ${clause ? "AND" : "WHERE"} (${invalidCosts} OR ${invalidTokens} OR ${invalidCacheWriteTtl} OR ${invalidTurns})
    LIMIT 1`,
    ...params
  );
  if (!row) {
    return;
  }
  if (Number(row.invalid_token)) {
    throw new InvalidTokenCountError(`session ${row.id} token_usage`);
  }
  if (Number(row.invalid_cost)) {
    throw new Error(`Invalid persisted cost in session ${row.id}`);
  }
  throw new Error(`Invalid persisted turn count in session ${row.id}`);
}
