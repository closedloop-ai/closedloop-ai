/**
 * The Insights trend-series lookback cap.
 *
 * Alone in a module with NO imports, on purpose. `resolveRange` is its natural
 * home, but that module reaches `db-helpers.ts` and from there
 * `@repo/api/src/types/agent-component` — a main-process graph the Playwright
 * loader cannot resolve, which aborts the whole `desktop-e2e` run before any
 * spec executes (wongk, PR #4974). The e2e seed helper needs this value and
 * nothing else from that graph, so the value lives where a test can reach it
 * without dragging the graph along.
 *
 * FEA-2210: trend sparklines and the activity heatmap follow the selected period
 * but are capped here, so long ranges — and "all" — stay readable. KPI totals
 * are deliberately NOT capped by it.
 */
export const TREND_LOOKBACK_DAYS = 90;
