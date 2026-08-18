// Scope-switched dashboard data. app-mock.ts holds the "Me" set (a single
// developer's machine); this module layers the "Organization" set on top so
// flipping the Scope toggle after signing up actually swaps the payload (bigger
// population, more repos, an extra agent role) instead of relabeling the same
// numbers (PR #4368 review). Org scope is only reachable once signed up, so the
// selector falls back to the Me set for every other case.

import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";
import {
  type AiImpactMetric,
  aiImpactMetrics,
  type CategoryRow,
  heatmapWeeks,
  modelBreakdown,
  modelUsagePoints,
  modelUsageSeries,
  type PipelineNode,
  pipelineNodes,
  prByRepo,
  prTrendPoints,
  prTrendSeries,
  recentSessions,
  type SessionRow,
  type StatDatum,
  stats,
} from "./app-mock";

export type DashboardData = {
  stats: readonly StatDatum[];
  aiImpact: readonly AiImpactMetric[];
  heatmapWeeks: readonly AnalyticsHeatmapWeek[];
  recentSessions: readonly SessionRow[];
  modelUsagePoints: readonly TimeSeriesPointDatum[];
  modelUsageSeries: readonly TimeSeriesSeriesDef[];
  pipelineNodes: readonly PipelineNode[];
  prTrendPoints: readonly TimeSeriesPointDatum[];
  prTrendSeries: readonly TimeSeriesSeriesDef[];
  modelBreakdown: readonly CategoryRow[];
  prByRepo: readonly CategoryRow[];
};

// The headline stats and AI-impact tiles keep their labels, units, and info
// copy from the Me set (only the org-wide magnitudes change), so the two scopes
// can't drift on anything but the numbers.
const ORG_STAT_OVERRIDES: Record<string, { value: string; delta: number }> = {
  sessions: { value: "28,410", delta: 15 },
  cost: { value: "$214,900", delta: 6 },
  merged: { value: "1,342", delta: 22 },
  "pr-size": { value: "198", delta: -6 },
  kloc: { value: "266.5", delta: 9 },
};

const ORG_AI_IMPACT_OVERRIDES: Record<
  string,
  { value: string; detail: string }
> = {
  "cost-per-pr": { value: "$160", detail: "Model spend / PRs shipped" },
  "tokens-per-kloc": {
    value: "45.2K",
    detail: "Tokens / thousands of lines merged",
  },
  "top-model": { value: "Claude Opus", detail: "61% of spend" },
  "top-repo": { value: "web-app", detail: "512 merged PRs" },
};

const orgStats: readonly StatDatum[] = stats.map((stat) => ({
  ...stat,
  ...ORG_STAT_OVERRIDES[stat.key],
}));

const orgAiImpact: readonly AiImpactMetric[] = aiImpactMetrics.map(
  (metric) => ({
    ...metric,
    ...ORG_AI_IMPACT_OVERRIDES[metric.key],
  })
);

// The collaboration row gains a Tester role and org-wide hand-off counts.
const orgPipelineNodes: readonly PipelineNode[] = [
  { id: "plan", label: "Planner", sessions: 3120 },
  { id: "code", label: "Coder", sessions: 11_480 },
  { id: "review", label: "Reviewer", sessions: 6240 },
  { id: "test", label: "Tester", sessions: 4010 },
  { id: "ship", label: "Shipper", sessions: 2860 },
];

const orgModelBreakdown: readonly CategoryRow[] = [
  { key: "opus", label: "Claude Opus", value: 131_000 },
  { key: "gpt", label: "GPT-5.5", value: 52_400 },
  { key: "sonnet", label: "Claude Sonnet", value: 24_900 },
  { key: "gemini", label: "Gemini 2.5", value: 12_600 },
  { key: "grok", label: "Grok 4", value: 4200 },
];

const orgPrByRepo: readonly CategoryRow[] = [
  { key: "web-app", label: "web-app", value: 512 },
  { key: "api", label: "api", value: 388 },
  { key: "desktop", label: "desktop", value: 214 },
  { key: "mobile", label: "mobile", value: 132 },
  { key: "infra", label: "infra", value: 96 },
  { key: "docs", label: "docs", value: 40 },
];

// Team-wide recent runs: other people's work across the org's repos, so the
// list reads as the whole organization rather than one machine.
const orgRecentSessions: readonly SessionRow[] = [
  {
    id: "o1",
    name: "Ship billing webhooks",
    repo: "api",
    model: "claude-opus-4-8",
    cost: "$5.40",
    when: "1m ago",
    statusLabel: "Running",
    statusTone: "accent",
    pulse: true,
  },
  {
    id: "o2",
    name: "Redesign settings nav",
    repo: "web-app",
    model: "gpt-5.5",
    cost: "$3.10",
    when: "12m ago",
    statusLabel: "In review",
    statusTone: "info",
  },
  {
    id: "o3",
    name: "Add offline queue",
    repo: "desktop",
    model: "claude-sonnet-4-6",
    cost: "$1.28",
    when: "40m ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "o4",
    name: "Cut cold-start latency",
    repo: "infra",
    model: "claude-opus-4-8",
    cost: "$7.85",
    when: "2h ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "o5",
    name: "Localize onboarding",
    repo: "mobile",
    model: "gpt-5.5",
    cost: "$2.05",
    when: "4h ago",
    statusLabel: "Needs input",
    statusTone: "warning",
  },
  {
    id: "o6",
    name: "Draft data-retention docs",
    repo: "docs",
    model: "claude-sonnet-4-6",
    cost: "$0.72",
    when: "yesterday",
    statusLabel: "Merged",
    statusTone: "success",
  },
];

// The time-series and heatmap shapes carry over; only their magnitudes scale up
// to org volume, so the trends stay recognizable across scopes.
const scalePoints = (
  points: readonly TimeSeriesPointDatum[],
  factor: number
): TimeSeriesPointDatum[] =>
  points.map((point) => {
    const values: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(point.values)) {
      values[key] = value === null ? null : Math.round(value * factor);
    }
    return { date: point.date, values };
  });

const scaleHeatmap = (
  weeks: readonly AnalyticsHeatmapWeek[],
  factor: number
): AnalyticsHeatmapWeek[] =>
  weeks.map((week) =>
    week.map((day) => ({
      date: day.date,
      count: Math.round(day.count * factor),
    }))
  );

const meData: DashboardData = {
  stats,
  aiImpact: aiImpactMetrics,
  heatmapWeeks,
  recentSessions,
  modelUsagePoints,
  modelUsageSeries,
  pipelineNodes,
  prTrendPoints,
  prTrendSeries,
  modelBreakdown,
  prByRepo,
};

const orgData: DashboardData = {
  stats: orgStats,
  aiImpact: orgAiImpact,
  heatmapWeeks: scaleHeatmap(heatmapWeeks, 4),
  recentSessions: orgRecentSessions,
  modelUsagePoints: scalePoints(modelUsagePoints, 6),
  modelUsageSeries,
  pipelineNodes: orgPipelineNodes,
  prTrendPoints: scalePoints(prTrendPoints, 6),
  prTrendSeries,
  modelBreakdown: orgModelBreakdown,
  prByRepo: orgPrByRepo,
};

export const getDashboardData = (scope: string): DashboardData =>
  scope === "org" ? orgData : meData;
