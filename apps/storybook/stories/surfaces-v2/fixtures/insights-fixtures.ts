import type {
  AgentsInsightsResponse,
  KpiStat,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import { KpiDeltaBasis, KpiFormat } from "@repo/api/src/types/insights";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  dashboardAgentsFixture,
  dashboardApiRoutes,
  dashboardDeliveryFixture,
  dashboardUtilizationFixture,
} from "./dashboard-fixtures";
import { teamsFixture } from "./live-app-fixtures";

// The live Insights page (`apps/app/.../insights/page-client.tsx`) reads the
// same three sections as the Dashboard plus `GET /teams` for its scope picker,
// and its default layout draws more of each section than the Dashboard does
// (token split, events, tool runs, the per-type donuts and the event-volume
// heatmap). These responses are the Dashboard's week with those filled in.

const DATES = [
  "2026-09-30",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
] as const;

function series(key: string, label: string, values: number[]): TimeSeries {
  return {
    points: DATES.map((date, index) => ({
      date,
      values: { [key]: values[index] ?? null },
    })),
    series: [{ key, label }],
  };
}

function kpi(
  key: string,
  label: string,
  value: number,
  sub: string,
  deltaPct: number
): KpiStat {
  return {
    deltaBasis: KpiDeltaBasis.Computed,
    deltaPct,
    format: KpiFormat.Number,
    key,
    label,
    sub,
    value,
  };
}

export const insightsUtilizationFixture: UtilizationInsightsResponse = {
  ...dashboardUtilizationFixture,
  charts: {
    ...dashboardUtilizationFixture.charts,
    eventsByType: [
      { key: "tool_call", label: "Tool call", value: 18_420 },
      { key: "message", label: "Message", value: 9310 },
      { key: "file_edit", label: "File edit", value: 6120 },
      { key: "command", label: "Command", value: 2840 },
      { key: "error", label: "Error", value: 410 },
    ],
    eventVolume: series(
      "events",
      "Events",
      [4820, 5310, 4470, 6120, 2210, 1980, 5740]
    ),
  },
  kpis: [
    ...dashboardUtilizationFixture.kpis,
    kpi(InsightsKpiKey.Events, "Events", 37_100, "events recorded", 9),
  ],
};

export const insightsAgentsFixture: AgentsInsightsResponse = {
  ...dashboardAgentsFixture,
  charts: {
    ...dashboardAgentsFixture.charts,
    agentsByStatus: [
      { key: "completed", label: "Completed", value: 1012 },
      { key: "failed", label: "Failed", value: 96 },
      { key: "cancelled", label: "Cancelled", value: 64 },
      { key: "running", label: "Running", value: 18 },
    ],
    agentsByType: [
      { key: "code-reviewer", label: "code-reviewer", value: 318 },
      { key: "test-writer", label: "test-writer", value: 204 },
      { key: "design-critic", label: "design-critic", value: 97 },
      { key: "general-purpose", label: "general-purpose", value: 412 },
    ],
    tokenDistribution: [
      { key: "input", label: "Input", value: 31_400_000 },
      { key: "output", label: "Output", value: 16_800_000 },
      { key: "cache_read", label: "Cache read", value: 88_100_000 },
      { key: "cache_write", label: "Cache write", value: 9_600_000 },
    ],
    toolUsage: [
      { key: "Read", label: "Read", value: 6210 },
      { key: "Edit", label: "Edit", value: 4180 },
      { key: "Bash", label: "Bash", value: 3920 },
      { key: "Grep", label: "Grep", value: 2470 },
      { key: "Write", label: "Write", value: 980 },
    ],
  },
  kpis: [
    ...dashboardAgentsFixture.kpis,
    kpi(
      InsightsKpiKey.InputTokens,
      "Input tokens",
      31_400_000,
      "tokens in",
      10
    ),
    kpi(
      InsightsKpiKey.OutputTokens,
      "Output tokens",
      16_800_000,
      "tokens out",
      15
    ),
    kpi(
      InsightsKpiKey.CacheTokens,
      "Cache saved",
      88_100_000,
      "tokens read from cache",
      21
    ),
    kpi(InsightsKpiKey.ToolRuns, "Tool runs", 17_760, "tool calls", 8),
  ],
};

export const insightsApiRoutes: FixtureRoute[] = [
  { method: "GET", path: "/teams", respond: () => teamsFixture },
  {
    method: "GET",
    path: "/insights/delivery",
    respond: () => dashboardDeliveryFixture,
  },
  {
    method: "GET",
    path: "/insights/utilization",
    respond: () => insightsUtilizationFixture,
  },
  {
    method: "GET",
    path: "/insights/agents",
    respond: () => insightsAgentsFixture,
  },
  ...dashboardApiRoutes,
];
