import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";

// Mock data for the user profile page prototype. All numbers are invented but
// shaped to read like a real (strong, not superhuman) senior engineer's
// Closedloop telemetry: PR throughput, token use, efficiency, autonomy, spend,
// concurrency, plus a year-long contribution grid. Numbers were pulled back
// from the first draft's superhuman figures (412 PRs / 90d, 2nd of 148) to a
// plausible top-decile profile so the layout is tested against believable data.
//
// Each of the three range windows (30d/90d/1y) is HAND-AUTHORED below, not
// derived by scaling one fixture by day-count (PR #4285 review: that scaling
// approach froze every delta/sparkline at the 90-day fixture and multiplied 1y
// into a superhuman ~4x figure). The PRs-shipped total is the one exception:
// it is derived straight from `contributionHeatmap` below, so the headline
// card and the contribution graph can never tell two different stories about
// the same merged PRs.
//
// Nothing here is wired to the DB/API.

export type PersonProfile = {
  name: string;
  handle: string;
  title: string;
  org: string;
  initials: string;
  joinedLabel: string;
};

// The closed set of headline metrics this page renders. Keyed so the polarity
// map below (and the primary/secondary split in profile-page.tsx) can never
// silently drop or duplicate a metric.
export const HeadlineMetricKey = {
  PrsShipped: "prs-shipped",
  TokensTotal: "tokens-total",
  Efficiency: "loc-per-dollar",
  Autonomy: "autonomy",
  Spend: "spend",
  Concurrency: "concurrency",
} as const;
export type HeadlineMetricKey =
  (typeof HeadlineMetricKey)[keyof typeof HeadlineMetricKey];

export type HeadlineMetric = {
  key: HeadlineMetricKey;
  label: string;
  value: string | number;
  unitLabel?: string;
  detail: string;
  info: { what: string; how?: string };
  // Period-over-period change vs the prior window. Whole-number percent. The
  // caption is NOT stored per metric: it is derived once from the selected
  // range at render, so it can never drift from the control.
  delta: number;
  // Recent weekly values for the sparkline in the delta chip.
  sparkline: number[];
  // Which direction is GOOD for this metric (ISS-4633 / #4285 review). Mirrors
  // the semantics of the production KPI registry
  // (packages/app/insights/lib/kpi-polarity.ts) — Cost is lower-is-better,
  // raw token volume is neutral (it's the substance of spend, so calling its
  // rise "good" would contradict the Model spend card beside it) — restated
  // locally because a prototype cannot import @repo/app. See
  // HEADLINE_METRIC_POLARITY below for the per-metric call.
  polarity: MetricPolarity;
  // Whether this metric is safe to show on the public/shareable page. Cost and
  // absolute-spend figures are intentionally private (Parker's call, see the
  // prototype notes on public-page exposure).
  public: boolean;
};

export type RankStat = {
  scope: "org" | "global";
  label: string;
  // 1-based rank within the population.
  rank: number;
  population: number;
  // Top percentile, e.g. 3 means "top 3%".
  percentile: number;
  metric: string;
};

export type Badge = {
  key: string;
  title: string;
  detail: string;
  // A named lucide icon, resolved by the component (keeps mock data
  // presentation-agnostic).
  icon: BadgeIcon;
  tone: BadgeTone;
  earnedLabel: string;
};

export const BadgeIcon = {
  Flame: "flame",
  Trophy: "trophy",
  Zap: "zap",
  GitMerge: "git-merge",
} as const;
export type BadgeIcon = (typeof BadgeIcon)[keyof typeof BadgeIcon];

export const BadgeTone = {
  Gold: "gold",
  Streak: "streak",
  Milestone: "milestone",
} as const;
export type BadgeTone = (typeof BadgeTone)[keyof typeof BadgeTone];

export type PersonalBest = {
  key: string;
  label: string;
  value: string;
  when: string;
};

export type ModelSlice = {
  key: string;
  label: string;
  value: number;
};

export const person: PersonProfile = {
  name: "Dana Whitfield",
  handle: "dana.w",
  title: "Staff Engineer · Platform",
  org: "Northwind Labs",
  initials: "DW",
  joinedLabel: "Joined Feb 2026",
};

// The window the whole in-app page is scoped to, picked by the range control
// in the Headlines section header (the only section it drives — Standing and
// Milestones are lifetime/rank facts, and the contribution graph is
// deliberately always a full year; see profile-page.tsx). Every
// window-dependent number and caption derives from the selected value, so the
// control can never say "30d" over copy and figures that are really 90 days
// of data.
export const RangeDays = {
  Month: "30",
  Quarter: "90",
  Year: "365",
} as const;
export type RangeDays = (typeof RangeDays)[keyof typeof RangeDays];

export const DEFAULT_RANGE: RangeDays = RangeDays.Quarter;

// Window copy, keyed exhaustively so a new range cannot ship without its own
// caption. "last year" rather than "last 365 days" because that is how a
// person says it — and it is the SAME word the contribution graph's title
// uses for its (always-on) year window, so the two don't invent two phrases
// for one period once someone actually picks 1y (#4285 review).
export const RANGE_COPY: Record<RangeDays, { window: string; delta: string }> =
  {
    [RangeDays.Month]: { window: "last 30 days", delta: "vs. prior 30 days" },
    [RangeDays.Quarter]: { window: "last 90 days", delta: "vs. prior 90 days" },
    [RangeDays.Year]: { window: "last year", delta: "vs. prior year" },
  };

// The toggle hands back a bare string; narrow it here rather than casting.
export function isRangeDays(value: string): value is RangeDays {
  return Object.values(RangeDays).some((range) => range === value);
}

// Declared before `contributionHeatmap` below because that `export const`
// initializer calls `buildHeatmap()` at module eval, which reads these values
// (buildHeatmap -> anchorDate -> ANCHOR_ISO). Leaving any of them below the
// export is a temporal-dead-zone crash (the route 500s).
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ANCHOR_ISO = "2026-07-24T12:00:00Z";

function anchorDate(): Date {
  return new Date(ANCHOR_ISO);
}

// Build a GitHub-style contribution grid ending on the anchor day. The
// ActivityHeatmap primitive renders each week's first cell on its Sunday row
// and the last on Saturday, so the grid must START on a Sunday: we walk back
// from the anchor to the Sunday that opens the earliest visible week, then
// generate forward one day at a time so each cell's real weekday matches its
// row.
function buildHeatmap(weeks: number, peak: number): AnalyticsHeatmapWeek[] {
  const anchor = anchorDate();
  const start = anchorDate();
  // Earliest day shown = anchor - (weeks*7 - 1); back it up to that week's Sunday.
  start.setUTCDate(anchor.getUTCDate() - (weeks * DAYS_PER_WEEK - 1));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  const out: AnalyticsHeatmapWeek[] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const week: AnalyticsHeatmapWeek = [];
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      const date = cursor.toISOString().slice(0, 10);
      const dayOffset = Math.round(
        (anchor.getTime() - cursor.getTime()) / MS_PER_DAY
      );
      const weekend = d === 0 || d === 6;
      const ramp = (w + 1) / weeks;
      const base = weekend ? peak * 0.15 : peak * ramp;
      const count = Math.max(
        0,
        Math.round(base + wobble(dayOffset, peak * 0.4))
      );
      week.push({ date, count });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    out.push(week);
  }
  return out;
}

// Deterministic pseudo-jitter so the mock renders identically each build (no
// Math.random, which would churn the diff and break SSR hydration parity).
function wobble(seed: number, amplitude: number): number {
  const s = Math.sin(seed * 12.9898) * 43_758.5453;
  const frac = s - Math.floor(s);
  return (frac - 0.5) * 2 * amplitude;
}

// A single contribution grid: merged PRs per day over the past year. Parker's
// review cut the four trend charts (model usage / autonomy / spend over time)
// and the second heatmap — a brag wall is one glanceable claim, and the
// contribution graph is the artifact people actually read as one. Trend
// exploration lives on Insights filtered by user.
//
// Peak dropped from 9 to 3 (#4285 T27 review): the old peak read as ~45
// merged PRs in a single week by the recent stretch of the grid, nearly 3x
// what the "PRs shipped" headline card and the "Most PRs in a week" personal
// best claimed for the same period. The PRs-shipped total and the personal
// best below are now both DERIVED from this grid so the three numbers cannot
// drift apart again.
export const contributionHeatmap: AnalyticsHeatmapWeek[] = buildHeatmap(53, 3);

// Per-week merged-PR totals across the full grid, oldest week first. The
// single source every window-scoped PRs figure below reads from.
function heatmapWeekTotals(): number[] {
  return contributionHeatmap.map((week) =>
    week.reduce((sum, cell) => sum + cell.count, 0)
  );
}

function sumWeeks(weeks: number[]): number {
  return weeks.reduce((sum, count) => sum + count, 0);
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// `date` is always an ISO `YYYY-MM-DD` string from `buildHeatmap`; parse it
// directly rather than through `Date` + a locale formatter so the label can't
// shift a day under a non-UTC test/build timezone.
function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${MONTH_LABELS[(month ?? 1) - 1]} ${day}`;
}

type BusiestWeek = { total: number; weekStartIso: string };

// The heatmap's single busiest week, so "Most PRs in a week" in Personal
// Bests can never claim a number the grid itself doesn't back up.
function findBusiestWeek(): BusiestWeek {
  let best: BusiestWeek = { total: -1, weekStartIso: "" };
  for (const week of contributionHeatmap) {
    const total = week.reduce((sum, cell) => sum + cell.count, 0);
    if (total > best.total) {
      best = { total, weekStartIso: week[0]?.date ?? "" };
    }
  }
  return best;
}

function assertUnreachableRange(range: never): never {
  throw new Error(`Unhandled range: ${String(range)}`);
}

// The PRs-shipped headline total for each window, read directly off the
// contribution grid instead of a hand-typed constant, so the headline card
// and the graph can never contradict each other (#4285 T27/T30).
function prsShippedFor(range: RangeDays): number {
  const weeks = heatmapWeekTotals();
  switch (range) {
    case RangeDays.Month:
      // ~4 weeks, close enough to 30 days for a weekly-bucketed grid.
      return sumWeeks(weeks.slice(-4));
    case RangeDays.Quarter:
      return sumWeeks(weeks.slice(-13));
    case RangeDays.Year:
      return sumWeeks(weeks);
    default:
      return assertUnreachableRange(range);
  }
}

// The recent-weeks trend for the delta chip's sparkline, sliced from the same
// grid so it can't be a frozen copy of the 90-day series (#4285 T29/T34).
function prsSparklineFor(range: RangeDays): number[] {
  const weeks = heatmapWeekTotals();
  switch (range) {
    case RangeDays.Month:
      return weeks.slice(-4);
    case RangeDays.Quarter:
      return weeks.slice(-12);
    case RangeDays.Year:
      // ~monthly buckets across the full 53-week grid.
      return weeks.filter((_, index) => index % 4 === 0);
    default:
      return assertUnreachableRange(range);
  }
}

// Period-over-period change vs the prior window of the same length, computed
// from the same grid for 30d/90d. There's only one year of grid to read, so
// there's no prior-year grid to diff against for 1y — that one is
// hand-authored to reflect a full year of compounding growth, larger than any
// single quarter's swing (#4285 T29/T34: each range gets its own number,
// never the 90-day figure relabeled).
function prsDeltaFor(range: RangeDays): number {
  const weeks = heatmapWeekTotals();
  switch (range) {
    case RangeDays.Month: {
      const current = sumWeeks(weeks.slice(-4));
      const prior = sumWeeks(weeks.slice(-8, -4));
      return Math.round(((current - prior) / prior) * 100);
    }
    case RangeDays.Quarter: {
      const current = sumWeeks(weeks.slice(-13));
      const prior = sumWeeks(weeks.slice(-26, -13));
      return Math.round(((current - prior) / prior) * 100);
    }
    case RangeDays.Year:
      return 31;
    default:
      return assertUnreachableRange(range);
  }
}

// Token breakdown for the donut: in / out / cache read / cache write,
// hand-authored per window (not scaled off the 90-day fixture — a straight
// day-count scale put 1y at ~2.5B tokens, right back in superhuman territory,
// #4285 T30). The donut and the headline "Tokens used" card both read the
// SAME per-range slices through `tokenBreakdownFor()`, so they can never tell
// conflicting stories.
const TOKEN_BREAKDOWN_BY_RANGE: Record<RangeDays, readonly ModelSlice[]> = {
  [RangeDays.Month]: [
    { key: "input", label: "Input", value: 78_000_000 },
    { key: "output", label: "Output", value: 34_000_000 },
    { key: "cache-read", label: "Cache read", value: 94_000_000 },
    { key: "cache-write", label: "Cache write", value: 8_000_000 },
  ],
  [RangeDays.Quarter]: [
    { key: "input", label: "Input", value: 226_000_000 },
    { key: "output", label: "Output", value: 99_000_000 },
    { key: "cache-read", label: "Cache read", value: 272_000_000 },
    { key: "cache-write", label: "Cache write", value: 23_000_000 },
  ],
  [RangeDays.Year]: [
    { key: "input", label: "Input", value: 675_000_000 },
    { key: "output", label: "Output", value: 296_000_000 },
    { key: "cache-read", label: "Cache read", value: 812_000_000 },
    { key: "cache-write", label: "Cache write", value: 68_000_000 },
  ],
};

export function tokenBreakdownFor(range: RangeDays): ModelSlice[] {
  return TOKEN_BREAKDOWN_BY_RANGE[range].map((slice) => ({ ...slice }));
}

export function totalTokensFor(range: RangeDays): number {
  return tokenBreakdownFor(range).reduce((sum, slice) => sum + slice.value, 0);
}

// Compact "620M" / "1.85B" style label for a token count, derived so the
// headline card and the donut share one source of truth.
export function formatTokenTotal(count: number): string {
  const BILLION = 1_000_000_000;
  const MILLION = 1_000_000;
  if (count >= BILLION) {
    return `${(count / BILLION).toFixed(2)}B`;
  }
  return `${Math.round(count / MILLION)}M`;
}

// Tokens-used delta/sparkline per window. The total itself comes from
// `totalTokensFor()` above; only the trend chip's own numbers live here.
const TOKENS_DELTA_BY_RANGE: Record<
  RangeDays,
  { delta: number; sparkline: number[] }
> = {
  [RangeDays.Month]: {
    delta: 11,
    sparkline: [58, 60, 57, 62, 65, 63, 67, 70, 69, 72, 75, 78],
  },
  [RangeDays.Quarter]: {
    delta: 27,
    sparkline: [36, 39, 42, 41, 44, 48, 52, 55, 56, 60, 64, 68],
  },
  [RangeDays.Year]: {
    delta: 52,
    sparkline: [18, 20, 22, 25, 27, 30, 33, 37, 40, 45, 50, 55],
  },
};

function formatSpend(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

// A rate, not a total: it does not grow with a longer window. Hand-authored
// per range (recent window reads slightly higher than the year-long average,
// which includes the earlier, less-efficient months).
const EFFICIENCY_BY_RANGE: Record<
  RangeDays,
  { value: string; delta: number; sparkline: number[] }
> = {
  [RangeDays.Month]: {
    value: "3.5",
    delta: 5,
    sparkline: [3.2, 3.3, 3.3, 3.4, 3.4, 3.4, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5],
  },
  [RangeDays.Quarter]: {
    value: "3.4",
    delta: 12,
    sparkline: [2.9, 2.8, 3.0, 3.0, 3.1, 3.1, 3.2, 3.2, 3.3, 3.3, 3.4, 3.4],
  },
  [RangeDays.Year]: {
    value: "3.1",
    delta: 24,
    sparkline: [2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.9, 3.0, 3.0, 3.1, 3.1, 3.1],
  },
};

// An index, not a total: hands-off-ness of a session, not something that
// accumulates. Recent window trends a bit higher than the year-long average.
const AUTONOMY_BY_RANGE: Record<
  RangeDays,
  { value: number; delta: number; sparkline: number[] }
> = {
  [RangeDays.Month]: {
    value: 71,
    delta: 4,
    sparkline: [66, 67, 67, 68, 69, 69, 70, 70, 70, 71, 71, 71],
  },
  [RangeDays.Quarter]: {
    value: 68,
    delta: 9,
    sparkline: [54, 56, 55, 58, 60, 59, 62, 63, 64, 65, 67, 68],
  },
  [RangeDays.Year]: {
    value: 60,
    delta: 18,
    sparkline: [40, 43, 45, 48, 50, 52, 54, 55, 57, 58, 59, 60],
  },
};

// Estimated USD spend, hand-authored to track the token totals above rather
// than a flat day-count scale (which is how the first draft landed 1y at
// $16,709 — the same superhuman-total problem as PRs and tokens, #4285 T30).
const SPEND_BY_RANGE: Record<
  RangeDays,
  { value: number; delta: number; sparkline: number[] }
> = {
  [RangeDays.Month]: {
    value: 1420,
    delta: 3,
    sparkline: [320, 330, 325, 335, 345, 340, 350, 355, 360, 365, 370, 375],
  },
  [RangeDays.Quarter]: {
    value: 4120,
    delta: 6,
    sparkline: [300, 320, 330, 325, 350, 370, 375, 395, 405, 420, 425, 440],
  },
  [RangeDays.Year]: {
    value: 12_300,
    delta: 34,
    sparkline: [180, 200, 220, 240, 260, 285, 300, 320, 340, 360, 390, 420],
  },
};

// An average, not a total: how many sessions run at once, not a count that
// accumulates over a longer window.
const CONCURRENCY_BY_RANGE: Record<
  RangeDays,
  { value: string; delta: number; sparkline: number[] }
> = {
  [RangeDays.Month]: {
    value: "2.3",
    delta: 9,
    sparkline: [2.0, 2.0, 2.1, 2.1, 2.2, 2.2, 2.2, 2.3, 2.3, 2.3, 2.3, 2.3],
  },
  [RangeDays.Quarter]: {
    value: "2.1",
    delta: 21,
    sparkline: [1.3, 1.4, 1.5, 1.6, 1.7, 1.7, 1.8, 1.9, 1.9, 2.0, 2.0, 2.1],
  },
  [RangeDays.Year]: {
    value: "1.9",
    delta: 32,
    sparkline: [1.1, 1.2, 1.3, 1.3, 1.4, 1.5, 1.5, 1.6, 1.7, 1.7, 1.8, 1.9],
  },
};

// Which direction is GOOD for each headline metric (ISS-4633, #4285 T25).
// Exhaustive over `HeadlineMetricKey`, so a newly added metric fails
// typecheck until its polarity is stated, rather than silently rendering a
// rising bill as a green "improvement". Mirrors
// packages/app/insights/lib/kpi-polarity.ts's judgment calls, restated here
// because a prototype cannot import @repo/app:
// - Spend is lower-is-better, same as the production Cost KPI.
// - Tokens used is neutral: it's the substance of spend, so a rising count is
//   not a "win" sitting beside a Model spend card the reader reads as a cost.
// - Avg concurrency is a raw activity measure (how many sessions run at
//   once), same category as the production Sessions KPI (neutral) — we don't
//   actually know that running more sessions in parallel is "better".
// - PRs shipped and Efficiency (LOC/$) are delivery-outcome metrics, same
//   category as the production Merged/KLOC KPIs (higher-is-better).
// - Autonomy index is a maturity score explicitly trending toward a stated
//   goal (more agentic), closer to the production cache-savings KPI
//   (higher-is-better) than to a raw usage count.
const HEADLINE_METRIC_POLARITY: Record<HeadlineMetricKey, MetricPolarity> = {
  [HeadlineMetricKey.PrsShipped]: MetricPolarity.HigherIsBetter,
  [HeadlineMetricKey.TokensTotal]: MetricPolarity.Neutral,
  [HeadlineMetricKey.Efficiency]: MetricPolarity.HigherIsBetter,
  [HeadlineMetricKey.Autonomy]: MetricPolarity.HigherIsBetter,
  [HeadlineMetricKey.Spend]: MetricPolarity.LowerIsBetter,
  [HeadlineMetricKey.Concurrency]: MetricPolarity.Neutral,
};

// Headline "power" numbers for the selected window. `public` gates whether
// each appears on the share page. Dollar spend stays off the public
// LinkedIn-style card. The window is stated once by the section heading and
// once by the shared delta caption, never re-typed into an individual metric
// string.
export function headlineMetricsFor(range: RangeDays): HeadlineMetric[] {
  const tokensDelta = TOKENS_DELTA_BY_RANGE[range];
  const efficiency = EFFICIENCY_BY_RANGE[range];
  const autonomy = AUTONOMY_BY_RANGE[range];
  const spend = SPEND_BY_RANGE[range];
  const concurrency = CONCURRENCY_BY_RANGE[range];

  return [
    {
      key: HeadlineMetricKey.PrsShipped,
      label: "PRs shipped",
      value: prsShippedFor(range),
      detail: "Merged to a default branch",
      info: {
        what: "Pull requests you authored that merged to a default branch.",
        how: "Counted from merged PRs attributed to your sessions.",
      },
      delta: prsDeltaFor(range),
      sparkline: prsSparklineFor(range),
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.PrsShipped],
      public: true,
    },
    {
      key: HeadlineMetricKey.TokensTotal,
      label: "Tokens used",
      value: formatTokenTotal(totalTokensFor(range)),
      detail: "In + out + cache, all models",
      info: {
        what: "Total tokens across every model call in your sessions.",
        how: "Input + output + cache-read + cache-write, summed.",
      },
      delta: tokensDelta.delta,
      sparkline: tokensDelta.sparkline,
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.TokensTotal],
      public: true,
    },
    {
      key: HeadlineMetricKey.Efficiency,
      label: "Efficiency",
      value: efficiency.value,
      unitLabel: "LOC / $",
      detail: "Lines merged per dollar of model spend",
      info: {
        what: "Lines merged divided by model spend.",
        how: "Merged LOC ÷ estimated model spend over the range.",
      },
      delta: efficiency.delta,
      sparkline: efficiency.sparkline,
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.Efficiency],
      // In-app only. LOC/$ is cost-reverse-engineerable and reads as
      // inside-baseball externally, so it is kept off the public share card
      // (Parker's call). Dollar spend is likewise never public.
      public: false,
    },
    {
      key: HeadlineMetricKey.Autonomy,
      label: "Autonomy index",
      value: autonomy.value,
      unitLabel: "/ 100",
      detail: "Median session autonomy, trending agentic",
      info: {
        what: "How hands-off your sessions run. 0 = manual, 100 = agentic.",
        how: "Median session-autonomy index across the range.",
      },
      delta: autonomy.delta,
      sparkline: autonomy.sparkline,
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.Autonomy],
      public: true,
    },
    {
      key: HeadlineMetricKey.Spend,
      label: "Model spend",
      value: formatSpend(spend.value),
      detail: "Estimated over the range",
      info: {
        what: "Estimated USD spend across all model calls.",
        how: "Per-model token counts priced at list rates.",
      },
      delta: spend.delta,
      sparkline: spend.sparkline,
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.Spend],
      public: false,
    },
    {
      key: HeadlineMetricKey.Concurrency,
      label: "Avg concurrency",
      value: concurrency.value,
      unitLabel: "sessions",
      detail: "Active sessions running in parallel",
      info: {
        what: "Average number of sessions you had running at once.",
        how: "Mean of concurrent active sessions across active days.",
      },
      delta: concurrency.delta,
      sparkline: concurrency.sparkline,
      polarity: HEADLINE_METRIC_POLARITY[HeadlineMetricKey.Concurrency],
      public: true,
    },
  ];
}

export const ranks: RankStat[] = [
  {
    scope: "org",
    label: "in Northwind Labs",
    rank: 11,
    population: 148,
    percentile: 8,
    metric: "by PRs shipped",
  },
  {
    scope: "global",
    label: "across all Closedloop orgs",
    rank: 2140,
    population: 41_820,
    percentile: 6,
    metric: "by tokens used",
  },
];

export const streakDays = 19;
export const streakBest = 34;

// Achievement badges carry only what nothing else on the page already says, so
// each brag is said once. Dropped per review: the streak badge (the StreakTile
// above already shows current + best) and any "Top N% in org" badge (the org
// RankTile carries it). What stays are LIFETIME milestones — cumulative totals
// distinct from the range-scoped headline cards, which show only the selected
// window — so they add a fact rather than restating one.
export const badges: Badge[] = [
  {
    key: "lifetime-prs",
    title: "500 PRs shipped",
    detail: "Lifetime merged pull requests",
    icon: BadgeIcon.GitMerge,
    tone: BadgeTone.Milestone,
    earnedLabel: "Jun 2026",
  },
  {
    key: "lifetime-tokens",
    title: "1B tokens",
    detail: "Lifetime tokens across all models",
    icon: BadgeIcon.Zap,
    tone: BadgeTone.Milestone,
    earnedLabel: "May 2026",
  },
];

// The busiest week the contribution grid actually contains — read once here so
// "Most PRs in a week" can't quietly drift out of sync with the grid again
// (#4285 T27).
const busiestWeek = findBusiestWeek();

export const personalBests: PersonalBest[] = [
  {
    key: "prs-week",
    label: "Most PRs in a week",
    value: String(busiestWeek.total),
    when: `Week of ${formatShortDate(busiestWeek.weekStartIso)}`,
  },
  {
    key: "tokens-day",
    label: "Biggest token day",
    value: "22.4M",
    when: "Jul 9",
  },
  {
    key: "concurrency-peak",
    label: "Peak concurrency",
    value: "5 sessions",
    when: "Jul 2",
  },
  {
    key: "autonomy-peak",
    label: "Most autonomous session",
    value: "94 / 100",
    when: "Jul 15",
  },
];

// A metric as it appears on the PUBLIC card: only the display fields, with no
// `public` flag, no delta, and no sparkline. Cost/spend records never make it
// into this shape.
export type PublicMetric = {
  key: string;
  label: string;
  value: string | number;
  unitLabel?: string;
};

// The public projection of the profile. In production this is what the server
// would return for /p/<uuid> — a narrowed shape that excludes every private
// record (spend, efficiency) and internal-only field. The public share page
// consumes ONLY this, so the private $ figures are not filtered at render time
// out of the full internal dataset (which would still ship them in the client
// bundle); they are simply never part of the public projection.
export type PublicProfile = {
  name: string;
  title: string;
  org: string;
  initials: string;
  metrics: PublicMetric[];
  // States the snapshot window ("Last 90 days") so the card can't read as a
  // lifetime figure next to the Achievements badges, which genuinely are
  // lifetime (#4285 T26).
  windowLabel: string;
  streakDays: number;
  orgPercentile: number | null;
  badges: Badge[];
  publicUrl: string;
  og: { title: string; subtitle: string };
};

const PUBLIC_URL = "closedloop.dev/p/9f3c2a71";

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

// The share card is a fixed snapshot at the default window, not a view of
// whatever range the in-app page happens to be showing.
function buildPublicProfile(): PublicProfile {
  const windowMetrics = headlineMetricsFor(DEFAULT_RANGE);
  const windowLabel = capitalize(RANGE_COPY[DEFAULT_RANGE].window);
  const metrics: PublicMetric[] = windowMetrics
    .filter((metric) => metric.public)
    .map(({ key, label, value, unitLabel }) => ({
      key,
      label,
      value,
      unitLabel,
    }));
  const orgRank = ranks.find((rank) => rank.scope === "org") ?? null;
  const prs = windowMetrics.find(
    (metric) => metric.key === HeadlineMetricKey.PrsShipped
  );
  const tokens = windowMetrics.find(
    (metric) => metric.key === HeadlineMetricKey.TokensTotal
  );
  return {
    name: person.name,
    title: person.title,
    org: person.org,
    initials: person.initials,
    metrics,
    windowLabel,
    streakDays,
    orgPercentile: orgRank?.percentile ?? null,
    badges,
    publicUrl: PUBLIC_URL,
    og: {
      title: `${person.name} shipped ${prs?.value} PRs on Closedloop`,
      subtitle: `${windowLabel} · Top ${orgRank?.percentile}% at ${person.org} · ${tokens?.value} tokens used · ${streakDays}-day streak`,
    },
  };
}

export const publicProfile: PublicProfile = buildPublicProfile();
