import type { SessionWithAgents } from "../../shared/agent-db-contract.js";
import { resolveTokenUsageCostUsd } from "../agent-sync/agent-session-token-cost-resolution.js";
import { tokenCountValue } from "./db-helpers.js";
import type { SqliteTokenUsageRow } from "./db-row-types.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { groupRowsBySessionId } from "./session-detail-mappers.js";

/**
 * Decorate every session detail row with `estimatedCostUsd` — the per-session
 * authoritative `sessions.cost_usd_estimated` when the column carries one, else
 * the resolved sum over that session's `token_usage` rows (FEA-1459 Fix 10).
 *
 * Extracted out of `read-stores.ts` (ISS-6199): cost decoration is its own
 * concern, and the row reads it shares that file with are already the file's
 * whole responsibility.
 *
 * ISS-6199: both reads run on the READER POOL via `prisma.read`, one dispatch
 * each, and are issued concurrently — they are mutually independent id-scoped
 * reads, so awaiting them serially on the writer connection made every detail
 * read pay two round trips behind the first-launch backfill. Separate dispatches
 * fan out across pool connections (a single `read()` would pin one reader and
 * self-serialize them again). No read-your-writes requirement: the caller has
 * already awaited the rows these decorate.
 */
export async function attachEstimatedCosts(
  prisma: DesktopPrisma,
  sessions: SessionWithAgents[]
): Promise<void> {
  if (sessions.length === 0) {
    return;
  }
  const ids = sessions.map((s) => s.id);
  // `tokenUsage.findMany` is the typed form of the old selectTokenUsageRows; its
  // BigInt columns map to the snake_case SqliteTokenUsageRow shape and
  // token()-coerce in `sumResolvedTokenUsageCosts`.
  const [costRows, tokenRows] = await Promise.all([
    prisma.read((reader) =>
      reader.session.findMany({
        where: { id: { in: ids } },
        select: { id: true, costUsdEstimated: true },
      })
    ),
    prisma.read((reader) =>
      reader.tokenUsage.findMany({
        where: { sessionId: { in: ids } },
        select: {
          sessionId: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          cacheWrite5mTokens: true,
          cacheWrite1hTokens: true,
          createdAt: true,
          costUsdEstimated: true,
        },
        orderBy: [{ sessionId: "asc" }, { model: "asc" }],
      })
    ),
  ]);
  const costBySession = new Map(
    costRows
      .filter((row) => row.costUsdEstimated != null)
      .map((row) => [row.id, Number(row.costUsdEstimated)])
  );
  const tokenRowsBySessionId = groupRowsBySessionId(
    tokenRows.map((r) => ({
      session_id: r.sessionId,
      model: r.model,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_write_tokens: r.cacheWriteTokens,
      cache_write_5m_tokens: r.cacheWrite5mTokens,
      cache_write_1h_tokens: r.cacheWrite1hTokens,
      created_at: r.createdAt,
      cost_usd_estimated: r.costUsdEstimated,
    }))
  );
  for (const session of sessions) {
    const estimatedCostUsd =
      costBySession.get(session.id) ??
      sumResolvedTokenUsageCosts(tokenRowsBySessionId.get(session.id) ?? []);
    if (estimatedCostUsd !== undefined) {
      session.estimatedCostUsd = estimatedCostUsd;
    }
  }
}

function sumResolvedTokenUsageCosts(
  tokenRows: readonly SqliteTokenUsageRow[]
): number | undefined {
  let total = 0;
  let hasCost = false;
  for (const tokenRow of tokenRows) {
    const estimatedCostUsd = resolveTokenUsageCostUsd({
      ...tokenRow,
      input_tokens: tokenCountValue(tokenRow.input_tokens, "cost.input"),
      output_tokens: tokenCountValue(tokenRow.output_tokens, "cost.output"),
      cache_read_tokens: tokenCountValue(
        tokenRow.cache_read_tokens,
        "cost.cache_read"
      ),
      cache_write_tokens: tokenCountValue(
        tokenRow.cache_write_tokens,
        "cost.cache_write"
      ),
      cache_write_1h_tokens:
        tokenRow.cache_write_1h_tokens == null
          ? null
          : tokenCountValue(
              tokenRow.cache_write_1h_tokens,
              "cost.cache_write_1h"
            ),
    });
    if (estimatedCostUsd === undefined) {
      continue;
    }
    total += estimatedCostUsd;
    hasCost = true;
  }
  return hasCost ? total : undefined;
}
