import type {
  ActivityHeatmap,
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights";
import {
  InsightsGitHubProvenanceState,
  InsightsTileAvailabilityState,
  KpiDeltaBasis,
  KpiFormat,
} from "@repo/api/src/types/insights";
import { mixedAgentSessionListFixtures } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { liveAppShellRoutes, sessionListResponse } from "./live-app-fixtures";

// The live Dashboard (`apps/app/.../dashboard/page.tsx`) reads three Insights
// sections and the Recent Sessions list. These are their responses for one
// populated week. The cloud route never sends `autonomyTrend`,
// `frustrationTrend` (org opt-in) or `agentPipeline` (flag off), so neither do
// these, which keeps the rows the live dashboard shows.

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
    series: [{ key, label }],
    points: DATES.map((date, index) => ({
      date,
      values: { [key]: values[index] ?? null },
    })),
  };
}

const MODELS = [
  { key: "claude-opus", share: 0.54 },
  { key: "claude-sonnet", share: 0.31 },
  { key: "codex", share: 0.15 },
];

function modelSeries(scale: number): TimeSeries {
  return {
    series: MODELS.map((model) => ({ key: model.key, label: model.key })),
    points: DATES.map((date, dayIndex) => ({
      date,
      values: Object.fromEntries(
        MODELS.map((model) => [
          model.key,
          Number((model.share * scale * (1 + dayIndex * 0.08)).toFixed(2)),
        ])
      ),
    })),
  };
}

// Turn density by hour: busy working hours on weekdays, light weekends.
function activityHeatmap(): ActivityHeatmap {
  const cells = DATES.flatMap((day, dayIndex) => {
    const weekend = dayIndex === 4 || dayIndex === 5;
    return Array.from({ length: 24 }, (_unused, hour) => {
      const working = hour >= 9 && hour <= 18;
      const base = working ? 14 : 2;
      const scale = weekend ? 0.25 : 1;
      return {
        day,
        hour,
        human: Math.round(base * scale * (1 + ((hour + dayIndex) % 4) / 4)),
        agent: Math.round(
          base * 1.6 * scale * (1 + ((hour * dayIndex) % 5) / 5)
        ),
      };
    });
  });
  return { days: [...DATES], cells };
}

// GitHub-backed tiles render only when the producer vouches for them.
const GITHUB_TILES_AVAILABLE = {
  "kpi:merged": InsightsTileAvailabilityState.Available,
  "kpi:pr-size": InsightsTileAvailabilityState.Available,
  "kpi:kloc": InsightsTileAvailabilityState.Available,
  "chart:prTrend": InsightsTileAvailabilityState.Available,
  "chart:prByRepo": InsightsTileAvailabilityState.Available,
};

export const dashboardDeliveryFixture: DeliveryInsightsResponse = {
  tileAvailability: GITHUB_TILES_AVAILABLE,
  githubProvenance: {
    state: InsightsGitHubProvenanceState.Active,
    checkedAt: "2026-10-06T08:00:00.000Z",
  },
  kpis: [
    {
      key: InsightsKpiKey.Cost,
      label: "Cost",
      value: 4206,
      format: KpiFormat.Currency,
      sub: "Agent spend this period",
      deltaPct: 12,
      deltaBasis: KpiDeltaBasis.Computed,
    },
    {
      key: InsightsKpiKey.Merged,
      label: "Merged PRs",
      value: 92,
      format: KpiFormat.Number,
      sub: "pull requests merged",
      deltaPct: 4,
      deltaBasis: KpiDeltaBasis.Computed,
    },
    {
      key: InsightsKpiKey.PrSize,
      label: "Median PR size",
      value: 148,
      format: KpiFormat.Number,
      sub: "lines changed per pull request",
      deltaPct: -6,
      deltaBasis: KpiDeltaBasis.Computed,
    },
    {
      key: InsightsKpiKey.Kloc,
      label: "Lines merged",
      value: 12.4,
      format: KpiFormat.Number,
      sub: "thousand lines merged",
      deltaPct: 9,
      deltaBasis: KpiDeltaBasis.Computed,
    },
    // Operands the AI Impact card divides by; the producer marks them internal
    // so no tile draws them.
    {
      key: "mergedCount",
      label: "Merged PRs",
      value: 92,
      format: KpiFormat.Number,
      sub: "pull requests merged",
      deltaPct: null,
      internal: true,
    },
    {
      key: "mergedKloc",
      label: "Lines merged",
      value: 12.4,
      format: KpiFormat.Number,
      sub: "thousand lines merged",
      deltaPct: null,
      internal: true,
    },
  ],
  charts: {
    prTrend: series("merged", "Merged", [9, 11, 8, 14, 12, 16, 13]),
    klocTrend: series(
      "kloc",
      "Lines merged",
      [1.4, 1.9, 1.1, 2.2, 1.6, 2.4, 1.8]
    ),
    prByRepo: [
      {
        key: "closedloop-ai",
        label: "closedloop-ai/closedloop-ai",
        value: 41,
      },
      { key: "closedloop-desktop", label: "closedloop-ai/desktop", value: 23 },
      { key: "loops-api", label: "closedloop-ai/loops-api", value: 16 },
      { key: "docs", label: "closedloop-ai/docs", value: 12 },
    ],
    meanTimeToMerge: [],
    prByState: [],
    branchLifespan: [],
    branchesWithoutPr: [],
  },
};

export const dashboardUtilizationFixture: UtilizationInsightsResponse = {
  kpis: [
    {
      key: InsightsKpiKey.Sessions,
      label: "Agent sessions",
      value: 1284,
      format: KpiFormat.Number,
      sub: "sessions started",
      deltaPct: 12,
      deltaBasis: KpiDeltaBasis.Computed,
    },
  ],
  charts: {
    eventActivity: series(
      "sessions",
      "Sessions",
      [96, 104, 88, 132, 118, 151, 141]
    ),
    activityHeatmap: activityHeatmap(),
    reviewQueue: [],
  },
};

export const dashboardAgentsFixture: AgentsInsightsResponse = {
  kpis: [
    {
      key: InsightsKpiKey.Tokens,
      label: "Input + output tokens",
      value: 48_200_000,
      format: KpiFormat.Number,
      sub: "tokens",
      deltaPct: 12,
      deltaBasis: KpiDeltaBasis.Computed,
    },
  ],
  charts: {
    modelUsageOverTime: modelSeries(600),
    modelTokensOverTime: modelSeries(2_400_000),
    modelBreakdown: [
      { key: "claude-opus", label: "claude-opus", value: 2271.2 },
      { key: "claude-sonnet", label: "claude-sonnet", value: 1303.9 },
      { key: "codex", label: "codex", value: 630.9 },
    ],
  },
};

/** Every read the live Dashboard makes, answered for a populated week. */
export const dashboardApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  {
    method: "GET",
    path: "/insights/delivery",
    respond: () => dashboardDeliveryFixture,
  },
  {
    method: "GET",
    path: "/insights/utilization",
    respond: () => dashboardUtilizationFixture,
  },
  {
    method: "GET",
    path: "/insights/agents",
    respond: () => dashboardAgentsFixture,
  },
  {
    method: "GET",
    path: "/agent-sessions",
    respond: () => sessionListResponse(mixedAgentSessionListFixtures),
  },
];
