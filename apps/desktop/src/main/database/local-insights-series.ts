/**
 * Chart time-series shaping for the desktop-local Insights backend.
 *
 * Split out of `local-insights.ts` so that file owns the SQL/aggregation work
 * and this module owns one responsibility: turning per-day aggregate rows into
 * the gap-filled, series-declared `TimeSeries` shapes the Insights renderers
 * consume. Everything here is a pure function of its rows plus a `Range` — no
 * database access.
 */
import type {
  TimeSeries,
  TimeSeriesSeries,
} from "@closedloop-ai/loops-api/insights";
import { numberOrZero as num } from "./db-helpers.js";
import { eachDay, type Range } from "./local-insights-range.js";
import { allocateRoundedUsdValues } from "./usd-allocation.js";

const MAX_MODEL_SERIES = 6;

// FEA-2486: PR throughput split. "agent" = the PR has session PR-creation
// evidence (a relation='created' artifact link); "manual" = no such evidence —
// which includes genuinely hand-raised PRs AND PRs raised outside captured
// sessions (other machines, bots, cloud loops).
const PR_TREND_SERIES: TimeSeriesSeries[] = [
  { key: "agent", label: "Agent-raised" },
  { key: "manual", label: "Manual/untracked" },
];

// Build the spend ($) and token (#) time-series for the Model Usage chart's
// $/# toggle (FEA-3497). Both stack over the SAME top-N model keys (top-N by
// spend) so toggling the metric only swaps y-values — the legend, colors, and
// stacking order stay stable. Mirrors the cloud `modelUsageSeries`
// (apps/api/app/insights/service.ts) so web and desktop agree.
export function buildModelSeries(
  rows: Array<{
    day: string;
    model: string;
    value: number;
    tokens: number | bigint;
  }>,
  range: Range
): { spend: TimeSeries; tokens: TimeSeries } {
  // FEA-2331: spend values are USD (float), so accumulate with plain numeric
  // addition — the storage-token helpers reject fractional values by design.
  const totalsByModel = new Map<string, number>();
  for (const r of rows) {
    totalsByModel.set(
      r.model,
      (totalsByModel.get(r.model) ?? 0) + num(r.value)
    );
  }
  const topModels = [...totalsByModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MODEL_SERIES)
    .map(([model]) => model);
  const topSet = new Set(topModels);
  const seriesKey = (model: string) => (topSet.has(model) ? model : "other");
  const usesOther = rows.some((r) => !topSet.has(r.model));

  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: "other", label: "Other" });
  }

  // Accumulate spend and tokens into the same top-N/"other" keys per day.
  const spendByDay = new Map<string, Record<string, number>>();
  const tokensByDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = seriesKey(r.model);
    const spendDay = spendByDay.get(r.day) ?? {};
    spendDay[key] = (spendDay[key] ?? 0) + num(r.value);
    spendByDay.set(r.day, spendDay);
    const tokenDay = tokensByDay.get(r.day) ?? {};
    tokenDay[key] = (tokenDay[key] ?? 0) + num(r.tokens);
    tokensByDay.set(r.day, tokenDay);
  }

  const days = eachDay(range.trendStartIso, range.endIso);
  const spend: TimeSeries = {
    series,
    // FEA-2331: exact-cents allocation preserves each day's stacked USD total.
    points: days.map((date) => ({
      date,
      values: allocateRoundedUsdValues(spendByDay.get(date) ?? {}),
    })),
  };
  const tokens: TimeSeries = {
    series,
    // Token counts are already whole integers; emit as-is (no cents allocation).
    points: days.map((date) => ({
      date,
      values: tokensByDay.get(date) ?? {},
    })),
  };
  return { spend, tokens };
}

export function gapFilledSeries(
  countsByDay: Map<string, number>,
  range: Range,
  series: TimeSeriesSeries,
  gapValue: number | null = 0
): TimeSeries {
  const points = eachDay(range.trendStartIso, range.endIso).map((date) => ({
    date,
    values: { [series.key]: countsByDay.get(date) ?? gapValue },
  }));
  return { series: [series], points };
}

// FEA-2486: two declared series (agent/manual) plus an UNDECLARED "merged"
// total key. The kpi:merged sparkline reads values.merged directly, while the
// bar/heatmap renderers sum only DECLARED series — the total key must stay out
// of `series` or those variants would double-count.
export function prSplitSeries(
  countsByDay: Map<string, { total: number; agent: number }>,
  range: Range
): TimeSeries {
  const points = eachDay(range.trendStartIso, range.endIso).map((date) => {
    const counts = countsByDay.get(date);
    const total = counts?.total ?? 0;
    const agent = counts?.agent ?? 0;
    return {
      date,
      values: { agent, manual: total - agent, merged: total },
    };
  });
  return { series: PR_TREND_SERIES, points };
}
