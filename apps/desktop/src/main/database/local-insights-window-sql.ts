/**
 * The shared `token_usage` window scope every local-Insights spend/cost read is
 * built from.
 *
 * Lives in its own module (rather than in `local-insights.ts`) so the Agents
 * section, the Delivery section (`local-insights-delivery.ts`) and the
 * spend-by-outcome chart (`local-insights-spend.ts`) all read the SAME window
 * predicate without any of them importing the composition root back.
 *
 * The spend scope and the prior-window cost take the window bounds as
 * positional params `$1` / `$2`; the current-window cost carries its own params
 * (ISS-12263), because an all-time Sessions window has none.
 *
 * ISS-10604 made the COLUMN a parameter too. It was `s.started_at` outright,
 * while the Sessions surface's own cost figure windows on last activity — so
 * one date range priced two different cohorts, and aligning the session COUNT
 * without aligning this would have moved the split rather than closed it.
 */

import type { SessionDateWindowField } from "../../shared/session-date-window-contract.js";
import {
  sessionDateWindowNotNullSql,
  sessionDateWindowTsExpr,
} from "../agent-sync/session-date-window.js";
import type { SessionsWindow } from "./local-insights-range.js";

/** `FROM token_usage ⋈ sessions` scoped to the window — the shared spend scope. */
export function currentWindowSpendScopeSql(
  dateWindowField: SessionDateWindowField
): string {
  return `FROM token_usage t
   JOIN sessions s ON s.id = t.session_id
   WHERE ${sessionDateWindowNotNullSql(dateWindowField)}
     AND ${sessionDateWindowTsExpr(dateWindowField)} BETWEEN $1 AND $2`;
}

/**
 * Total estimated cost over the Sessions-list window (ISS-12263): the
 * {@link currentWindowSpendScopeSql} join, bounded by {@link sessionsWindowSql}
 * rather than by a fixed `$1`/`$2` pair.
 */
export function currentWindowCostSql(
  dateWindowField: SessionDateWindowField,
  window: SessionsWindow
): { sql: string; params: string[] } {
  const predicate = sessionsWindowSql(dateWindowField, window);
  return {
    sql: `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
   FROM token_usage t
   JOIN sessions s ON s.id = t.session_id
   WHERE ${predicate.sql}`,
    params: predicate.params,
  };
}

/**
 * The same cost over the PRIOR window, whose bounds are HALF-OPEN
 * (`>= $1 AND < $2`) where the current window's are closed.
 *
 * Deliberately not {@link currentWindowCostSql} with different params: the prior
 * window ends exactly where the current one begins, so a closed upper bound
 * would count a session sitting on that instant in both halves of the delta and
 * report a period-over-period change that never happened.
 */
export function priorWindowCostSql(
  dateWindowField: SessionDateWindowField
): string {
  const windowTs = sessionDateWindowTsExpr(dateWindowField);
  return `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
   FROM token_usage t
   JOIN sessions s ON s.id = t.session_id
   WHERE ${sessionDateWindowNotNullSql(dateWindowField)}
     AND ${windowTs} >= $1 AND ${windowTs} < $2`;
}

/**
 * ISS-12263: the `sessions s` predicate for a Sessions-list window, with
 * positional params from `$1`. An absent bound emits no comparison, as
 * `buildListCursorFilterClause` does, so an all-time window admits a session
 * last active after today's UTC end. The closed bounds match the `BETWEEN` this
 * replaced.
 */
export function sessionsWindowSql(
  dateWindowField: SessionDateWindowField,
  window: SessionsWindow
): { sql: string; params: string[] } {
  const windowTs = sessionDateWindowTsExpr(dateWindowField);
  const conditions = [sessionDateWindowNotNullSql(dateWindowField)];
  const params: string[] = [];
  if (window.startDate) {
    params.push(window.startDate);
    conditions.push(`${windowTs} >= $${params.length}`);
  }
  if (window.endDate) {
    params.push(window.endDate);
    conditions.push(`${windowTs} <= $${params.length}`);
  }
  return { sql: conditions.join(" AND "), params };
}
