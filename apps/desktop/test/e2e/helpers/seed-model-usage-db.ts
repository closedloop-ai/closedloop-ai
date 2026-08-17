/**
 * ISS-5523 — seed per-model `token_usage` rows for the Dashboard's model usage
 * chart.
 *
 * A focused sibling of `seed-branches-db.ts` rather than another export bolted
 * onto it (per `apps/desktop/test/AGENTS.md`: new scenarios go in a focused
 * module, and that file is on the grandfather list).
 *
 * The existing `pricedTokenUsageBatchItem` hardcodes a single `'seed-model'`,
 * which is exactly right for the cost-filter specs it serves and useless here:
 * the model usage chart draws ONE SERIES PER DISTINCT `token_usage.model`, so a
 * corpus with one model name draws one band and the palette assignment this
 * ticket is about never happens. This seeds N distinct models with separated
 * magnitudes so the series order is deterministic.
 *
 * Seeds `token_usage` ONLY — the owning `sessions` row is expected to already
 * exist (seed it with `seedSessionsList` first), because `modelUsageOverTime`
 * joins `token_usage` to `sessions` and filters on `sessions.started_at`.
 */

import { createClient } from "@libsql/client";
import {
  applyDesktopSeedPragmas,
  branchesDbPath,
  waitForTablesPresent,
} from "./desktop-seed-core.js";

const MODEL_USAGE_REQUIRED_TABLES = ["sessions", "token_usage"] as const;

export type ModelUsageSeed = {
  /** The owning `sessions.id`. Must already be seeded. */
  sessionId: string;
  /**
   * Distinct model names, highest spend first. The local producer
   * (`buildModelSeries`) ranks by total spend and keeps the top 6, so the order
   * here decides which models survive into the drawn series.
   */
  models: readonly string[];
  /**
   * Spend for the first model; each subsequent model gets a strictly smaller
   * share so the ranking is unambiguous and the legend order is stable.
   */
  topCostUsd?: number;
};

/**
 * Write one `token_usage` row per model, with strictly descending cost.
 *
 * Call while the app is DOWN, between launches — the db host runs its
 * migrations asynchronously after launch, so `waitForTablesPresent` is what
 * makes this safe to call right after the first launch closes.
 */
export async function seedModelUsage(
  userDataDir: string,
  seed: ModelUsageSeed,
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForTablesPresent(
      client,
      MODEL_USAGE_REQUIRED_TABLES,
      options.schemaTimeoutMs ?? 30_000
    );

    const topCost = seed.topCostUsd ?? 12;
    await client.batch(
      seed.models.map((model, index) => ({
        sql: `INSERT INTO token_usage
                (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          seed.sessionId,
          model,
          // Nominal token counts; the chart's default view stacks SPEND, and
          // these only need to be positive so the row reads as real usage.
          10_000 - index * 500,
          4000 - index * 200,
          // Strictly descending, and never rounding to a tie at 2dp.
          Number((topCost / (index + 1)).toFixed(4)),
        ],
      })),
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}
