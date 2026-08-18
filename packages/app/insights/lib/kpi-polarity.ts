import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";

/**
 * The KPI metric registry: which metrics exist, and which direction is good for
 * each (ISS-4633). Kept separate from `tile-catalog.ts` — that file owns tile
 * LAYOUT (grid, sections, chart variants), this one owns metric SEMANTICS, and
 * they change for different reasons.
 */

/**
 * Every KPI metric the dashboard can render a tile for. The key is the wire
 * `KpiStat.key` the insights backends emit. Adding a KPI tile means adding its
 * key here, which in turn forces an entry in {@link KPI_METRIC_POLARITY} —
 * a new metric cannot reach the delta chip without declaring which direction
 * is good for it.
 */
export const InsightsKpiKey = {
  Merged: "merged",
  Ttm: "ttm",
  Kloc: "kloc",
  Cost: "cost",
  MergeRate: "merge-rate",
  PrSize: "pr-size",
  Sessions: "sessions",
  Runtime: "runtime",
  Backlog: "backlog",
  Events: "events",
  Tokens: "tokens",
  InputTokens: "input-tokens",
  OutputTokens: "output-tokens",
  CacheTokens: "cache-tokens",
  Models: "models",
  ToolRuns: "tool-runs",
} as const;
export type InsightsKpiKey =
  (typeof InsightsKpiKey)[keyof typeof InsightsKpiKey];

/**
 * Which direction is GOOD for each KPI. Exhaustive over {@link InsightsKpiKey},
 * so a newly added KPI fails typecheck until its polarity is stated rather than
 * silently inheriting the throughput reading and rendering, say, a 38% spend
 * increase as a green "improving" chip.
 *
 * Judgement calls, stated once here rather than re-argued per surface:
 * - `pr-size` is lower-is-better — a growing median PR is a review-health
 *   regression, not a delivery win.
 * - The raw token counts and `runtime` are NEUTRAL, not higher-is-better. They
 *   are the substance of spend, so a month where tokens rose 38% and cost rose
 *   38% would otherwise render a green "better" beside a red "worse" for the
 *   same movement. `cache-tokens` stays higher-is-better because a growing
 *   saving genuinely is one.
 * - `models` ("Models in use") is neutral: a rise reads as model sprawl or as
 *   healthy experimentation depending on the reader, and a colour would have to
 *   pick one.
 * - `sessions`, `events`, and `tool-runs` are NEUTRAL raw activity counts
 *   (review on #4148). They measure how much the product was used, not a
 *   delivery outcome, so a quiet week's decline is not a moral "worse" — we do
 *   not actually know a team running fewer sessions is bad. Only the metrics we
 *   have a real opinion on carry a verdict word: delivery output (merged PRs,
 *   KLOC, merge rate), spend/latency (cost, time-to-merge), review health (PR
 *   size, backlog), and cache savings. `merged` and `kloc` stay
 *   higher-is-better because they are shipped-work outcomes, not raw usage.
 */
export const KPI_METRIC_POLARITY: Record<InsightsKpiKey, MetricPolarity> = {
  [InsightsKpiKey.Merged]: MetricPolarity.HigherIsBetter,
  [InsightsKpiKey.Ttm]: MetricPolarity.LowerIsBetter,
  [InsightsKpiKey.Kloc]: MetricPolarity.HigherIsBetter,
  [InsightsKpiKey.Cost]: MetricPolarity.LowerIsBetter,
  [InsightsKpiKey.MergeRate]: MetricPolarity.HigherIsBetter,
  [InsightsKpiKey.PrSize]: MetricPolarity.LowerIsBetter,
  [InsightsKpiKey.Sessions]: MetricPolarity.Neutral,
  [InsightsKpiKey.Runtime]: MetricPolarity.Neutral,
  [InsightsKpiKey.Backlog]: MetricPolarity.LowerIsBetter,
  [InsightsKpiKey.Events]: MetricPolarity.Neutral,
  [InsightsKpiKey.Tokens]: MetricPolarity.Neutral,
  [InsightsKpiKey.InputTokens]: MetricPolarity.Neutral,
  [InsightsKpiKey.OutputTokens]: MetricPolarity.Neutral,
  [InsightsKpiKey.CacheTokens]: MetricPolarity.HigherIsBetter,
  [InsightsKpiKey.Models]: MetricPolarity.Neutral,
  [InsightsKpiKey.ToolRuns]: MetricPolarity.Neutral,
};
