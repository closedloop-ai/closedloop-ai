import { residualSeries } from "@closedloop-ai/loops-api/insights";
import type {
  CategoryBucket,
  TimeSeries,
  TimeSeriesSeries,
} from "@repo/api/src/types/insights";
import { eachDayKey } from "../lib/daily-buckets";
import { round } from "./buckets";

const MAX_MODEL_SERIES = 6;

// One DB-aggregated (day, model) bucket for the model-usage series (FEA-2331:
// estimated spend in USD; FEA-3497: total token volume — input + output + cache
// read/write — for the $/# usage toggle), date-bucketed in the requester's tz.
export type ModelUsageDayRow = {
  day: string;
  model: string;
  cost: number;
  tokens: number;
};

// Spend ($) and token (#) time-series for the Model Usage chart's $/# toggle
// (FEA-3497). Both are built over the SAME top-N model keys (top-N by spend, from
// `breakdown`) so toggling the metric only swaps y-values — the legend, colors,
// and stacking order stay stable.
export function modelUsageSeries(
  rows: ModelUsageDayRow[],
  breakdown: CategoryBucket[],
  start: Date,
  end: Date,
  timeZone?: string
): { spend: TimeSeries; tokens: TimeSeries } {
  const topModels = breakdown
    .slice(0, MAX_MODEL_SERIES)
    .map((bucket) => bucket.key);
  return {
    // FEA-2331: estimated spend (USD), rounded to whole cents once at emit.
    spend: stackModelSeries(rows, topModels, start, end, timeZone, {
      valueOf: (row) => row.cost,
      round: (value) => round(value, 2),
    }),
    // FEA-3497: total token volume (input + output + cache), whole integers.
    tokens: stackModelSeries(rows, topModels, start, end, timeZone, {
      valueOf: (row) => row.tokens,
      round: Math.round,
    }),
  };
}

// Stack per-(day, model) rows into a `TimeSeries` over a fixed top-N model set,
// collapsing models outside the top-N into "other". Shared by the spend and
// token series so both agree on which models appear (FEA-3497).
function stackModelSeries(
  rows: ModelUsageDayRow[],
  topModels: string[],
  start: Date,
  end: Date,
  timeZone: string | undefined,
  metric: {
    valueOf: (row: ModelUsageDayRow) => number;
    round: (value: number) => number;
  }
): TimeSeries {
  const topSet = new Set(topModels);
  // The residual key is drawn from the SAME unconstrained string space as the
  // model names it collects (see the note below — nothing on the path from the
  // sync POST to this fold constrains a model name). A model literally called
  // "other" would therefore share it: its spend would be summed into the
  // residual and the response would ship two `series` entries with one key.
  // Suffixed only on collision, so every payload without such a model is
  // byte-identical to before (ISS-8564).
  const residual = residualSeries(topModels);
  const seriesKey = (model: string) =>
    topSet.has(model) ? model : residual.key;

  // A model name rides in verbatim from `agent_session_token_usage.model` and
  // nothing on the path between the sync POST and this fold constrains it, so
  // every keyed container here is null-prototype (AGENTS.md: "a plain `{}`
  // lookup with untrusted keys can hit `__proto__` or `constructor`"). With a
  // plain literal, `day["__proto__"]` reads back Object.prototype instead of
  // undefined, the `?? 0` never fires, and the write hits the `__proto__`
  // setter, which drops it — erasing that model's spend from the chart while
  // the KPI still counts it (ISS-8233).
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const day = byDay.get(row.day) ?? emptyValueBucket();
    const sKey = seriesKey(row.model);
    // Rows already carry the per-(day, model) DB sum; models outside the top-N
    // collapse into "other" and round once at emit (below) to avoid drift.
    day[sKey] = (day[sKey] ?? 0) + metric.valueOf(row);
    byDay.set(row.day, day);
  }

  // usesOther ⟺ a model outside the top-N appears in the trend-window rows.
  // Previously derived as `breakdown.length > MAX_MODEL_SERIES` (full-period
  // breakdown), but `rows` only covers the 90-day trend window so the two
  // windows can disagree: a model active long ago but absent from the trend
  // window would incorrectly show an "Other" series with no data. Derive from
  // the rows themselves — the same set that populates the chart — to stay
  // accurate regardless of window differences (#2498).
  const usesOther = rows.some((row) => !topSet.has(row.model));
  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: residual.key, label: residual.label });
  }

  const valueKeys = usesOther ? [...topModels, residual.key] : topModels;
  const points = eachDayKey(start, end, timeZone).map((date) => {
    const raw = byDay.get(date) ?? emptyValueBucket();
    const rounded: Record<string, number> = emptyValueBucket();
    for (const key of valueKeys) {
      const value = raw[key];
      if (value !== undefined) {
        rounded[key] = metric.round(value);
      }
    }
    return { date, values: rounded };
  });
  return { series, points };
}

// Null-prototype bucket keyed by an untrusted model name. Behaves exactly like
// `{}` for every ordinary key — same insertion order, same JSON — and differs
// only where a key collides with an `Object.prototype` member, which is the
// whole point.
function emptyValueBucket(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}
