/**
 * Chart time-series shaping for the desktop-local Insights backend.
 *
 * Split out of `local-insights.ts` so that file owns the SQL/aggregation work
 * and this module owns one responsibility: turning per-day aggregate rows into
 * the gap-filled, series-declared `TimeSeries` shapes the Insights renderers
 * consume. Everything here is a pure function of its rows plus a `Range` — no
 * database access.
 */
import {
  residualSeries,
  type TimeSeries,
  type TimeSeriesSeries,
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
  // Same collision the cloud fold guards (ISS-8564): a model literally named
  // "other" would otherwise share the residual bucket's key, merging its spend
  // into the residual and emitting two `series` entries with one key. Shared
  // helper rather than a second copy of the rule, because this fold and
  // `modelUsageSeries` are mirrors and must not drift.
  const residual = residualSeries(topModels);
  const seriesKey = (model: string) =>
    topSet.has(model) ? model : residual.key;
  const usesOther = rows.some((r) => !topSet.has(r.model));

  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: residual.key, label: residual.label });
  }

  // Accumulate spend and tokens into the same top-N/"other" keys per day.
  const spendByDay = new Map<string, Record<string, number>>();
  const tokensByDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const key = seriesKey(r.model);
    const spendDay = spendByDay.get(r.day) ?? createDayTotals();
    addDayTotal(spendDay, key, num(r.value));
    spendByDay.set(r.day, spendDay);
    const tokenDay = tokensByDay.get(r.day) ?? createDayTotals();
    addDayTotal(tokenDay, key, num(r.tokens));
    tokensByDay.set(r.day, tokenDay);
  }

  const days = eachDay(range.trendStartIso, range.elapsedEndIso);
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
    // Spread, so the null-prototype accumulator never reaches the wire — the
    // spend half gets that for free from `allocateRoundedUsdValues`'s
    // `Object.fromEntries`; this is the token half's equivalent boundary.
    points: days.map((date) => ({
      date,
      values: { ...tokensByDay.get(date) },
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
  const points = eachDay(range.trendStartIso, range.elapsedEndIso).map(
    (date) => ({
      date,
      values: { [series.key]: countsByDay.get(date) ?? gapValue },
    })
  );
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
  const points = eachDay(range.trendStartIso, range.elapsedEndIso).map(
    (date) => {
      const counts = countsByDay.get(date);
      const total = counts?.total ?? 0;
      const agent = counts?.agent ?? 0;
      return {
        date,
        values: { agent, manual: total - agent, merged: total },
      };
    }
  );
  return { series: PR_TREND_SERIES, points };
}

/**
 * One day's per-series totals start as: a map with no prototype.
 *
 * The series key is `seriesKey(r.model)`, and `r.model` is the model string as
 * the local SQLite stored it — transcript-controlled, never allow-listed. On a
 * plain `{}` a model named `"__proto__"` or `"constructor"` reads back as an
 * inherited member, so the `?? 0` never fires and that model's whole day of
 * spend and tokens is silently lost from the chart (ISS-8234) — the same defect
 * `buildTraceActivityFields` carried, against the same value.
 */
function createDayTotals(): Record<string, number> {
  return Object.create(null);
}

/** See {@link createDayTotals}: `hasOwn` to read, `defineProperty` to create. */
function addDayTotal(
  totals: Record<string, number>,
  key: string,
  value: number
): void {
  if (Object.hasOwn(totals, key)) {
    totals[key] += value;
    return;
  }
  Object.defineProperty(totals, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
