/**
 * The shared `token_usage` window scope every local-Insights spend/cost read is
 * built from.
 *
 * Lives in its own module (rather than in `local-insights.ts`) so the Agents
 * section, the Delivery section (`local-insights-delivery.ts`) and the
 * spend-by-outcome chart (`local-insights-spend.ts`) all read the SAME window
 * predicate without any of them importing the composition root back.
 *
 * Both fragments take the window bounds as positional params `$1` / `$2`.
 */

/** `FROM token_usage ⋈ sessions` scoped to the window — the shared spend scope. */
export const currentWindowSpendScopeSql = `FROM token_usage t
   JOIN sessions s ON s.id = t.session_id
   WHERE s.started_at IS NOT NULL
     AND s.started_at BETWEEN $1 AND $2`;

/** Total estimated cost over {@link currentWindowSpendScopeSql}'s window. */
export const currentWindowCostSql = `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
   ${currentWindowSpendScopeSql}`;
