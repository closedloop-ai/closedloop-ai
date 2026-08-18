import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";

export const heroCopy = {
  subtitle:
    "We parse your agent sessions and show you where spend goes, what’s working, and how to build more efficiently.",
  primaryCta: "Get Started",
  signInPrompt: "Already have an account?",
  signInCta: "Sign in",
} as const;

export const AppRoute = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
} as const;
export type AppRoute = (typeof AppRoute)[keyof typeof AppRoute];

export const NavIconName = {
  Branches: "branches",
  Dashboard: "dashboard",
  Sessions: "sessions",
} as const;
export type NavIconName = (typeof NavIconName)[keyof typeof NavIconName];

export const navItems = [
  {
    label: "Dashboard",
    route: AppRoute.Dashboard,
    icon: NavIconName.Dashboard,
  },
  {
    label: "Sessions",
    route: AppRoute.Sessions,
    icon: NavIconName.Sessions,
  },
  {
    label: "Branches",
    route: AppRoute.Branches,
    icon: NavIconName.Branches,
  },
] as const;

export const activityTotals = {
  branches: 42,
  sessions: 4695,
} as const;

export type AiImpactMetricRow = {
  key: string;
  label: string;
  value: string;
  detail: string;
  requiresGitHub: boolean;
};

export const aiImpactMetrics: readonly AiImpactMetricRow[] = [
  {
    key: "cost-per-pr",
    label: "Cost per merged PR",
    value: "$172",
    detail: "Estimated cost ÷ PRs shipped",
    requiresGitHub: true,
  },
  {
    key: "tokens-per-kloc",
    label: "Tokens per KLOC",
    value: "57K",
    detail: "Tokens ÷ thousands of lines merged",
    requiresGitHub: true,
  },
  {
    key: "top-model",
    label: "Top model by cost",
    value: "Claude Opus",
    detail: "34% of cost",
    requiresGitHub: false,
  },
  {
    key: "top-repo",
    label: "Top repo by output",
    value: "web-app",
    detail: "24 merged PRs",
    requiresGitHub: true,
  },
] as const;

export type ActivityRow = {
  id: string;
  title: string;
  subtitle: string;
  value: string;
  status: ActivityStatus;
};

export const ActivityStatus = {
  InReview: "In review",
  Merged: "Merged",
  Open: "Open",
} as const;
export type ActivityStatus =
  (typeof ActivityStatus)[keyof typeof ActivityStatus];

export const recentSessions: readonly ActivityRow[] = [
  {
    id: "ses-248",
    title: "Checkout retry handling",
    subtitle: "you · Codex · 34m",
    value: "142 lines/$",
    status: ActivityStatus.Merged,
  },
  {
    id: "ses-247",
    title: "Permissions audit",
    subtitle: "you · Claude · 51m",
    value: "128 lines/$",
    status: ActivityStatus.InReview,
  },
  {
    id: "ses-246",
    title: "Session filters",
    subtitle: "you · Codex · 27m",
    value: "116 lines/$",
    status: ActivityStatus.Merged,
  },
  {
    id: "ses-245",
    title: "Desktop reconnect flow",
    subtitle: "you · Claude · 43m",
    value: "94 lines/$",
    status: ActivityStatus.Open,
  },
];

export const recentBranches: readonly ActivityRow[] = [
  {
    id: "branch-42",
    title: "feat/checkout-retries",
    subtitle: "Payments · updated 12m ago",
    value: "6 sessions",
    status: ActivityStatus.InReview,
  },
  {
    id: "branch-41",
    title: "fix/permission-scope",
    subtitle: "Platform · updated 38m ago",
    value: "4 sessions",
    status: ActivityStatus.Merged,
  },
  {
    id: "branch-40",
    title: "feat/session-filters",
    subtitle: "Product · updated 1h ago",
    value: "8 sessions",
    status: ActivityStatus.Open,
  },
];

export type TourChip = {
  text: string;
  ok?: boolean;
  warn?: boolean;
  muted?: boolean;
};

export type TourSummaryRow = {
  key: string;
  label: string;
  value?: string;
  sub?: string;
  chips?: readonly TourChip[];
};

export const tourSummary: readonly TourSummaryRow[] = [
  {
    key: "sessions",
    label: "Sessions parsed",
    value: "4,695",
    sub: "total detected",
  },
  {
    key: "harnesses",
    label: "Harnesses found",
    chips: [
      { text: "Claude Code", ok: true },
      { text: "Codex", ok: true },
      { text: "Gemini CLI (best effort)", warn: true },
    ],
    sub: "Only Claude Code and Codex are validated harnesses. Anything else is read on a best-effort basis.",
  },
  {
    key: "models",
    label: "Models found",
    chips: [
      { text: "claude-opus-4-7" },
      { text: "gpt-5.5" },
      { text: "claude-sonnet-4-6" },
      { text: "gemini-2.5-pro" },
      { text: "+7 more", muted: true },
    ],
    sub: "11 distinct models across Claude, OpenAI, and Gemini.",
  },
];

export type TourStep = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  target?: string;
  intro?: boolean;
};

export const tourSteps: readonly TourStep[] = [
  {
    id: "intro",
    eyebrow: "Ready",
    title: "Your insights are waiting.",
    body: "We found 4,695 sessions on this Mac. Here's what Closedloop can show you.",
    intro: true,
  },
  {
    id: "stats",
    eyebrow: "Your numbers",
    title: "The headline metrics",
    body: "Major metrics at a glance like Cost and Lines of Code merged.",
    target: "stats",
  },
  {
    id: "activity",
    eyebrow: "Activity",
    title: "When the work happens",
    body: "Each agent run and human input heatmapped across time.",
    target: "activity",
  },
  {
    id: "models",
    eyebrow: "Models",
    title: "Model breakdown",
    body: "See model cost over time and how it changes based on your usage.",
    target: "models",
  },
  {
    id: "prs",
    eyebrow: "Delivery",
    title: "PR throughput",
    body: "Your velocity over time based on PRs merged. Create an account to include your team's PRs merged and see the team's velocity.",
    target: "prs",
  },
] as const;

export const modelUsageSeries: TimeSeriesSeriesDef[] = [
  { key: "opus", label: "Claude Opus" },
  { key: "gpt", label: "GPT-5.5" },
  { key: "sonnet", label: "Claude Sonnet" },
];

export const modelUsagePoints: TimeSeriesPointDatum[] = [
  { date: "2026-05-04", values: { opus: 1800, gpt: 900, sonnet: 700 } },
  { date: "2026-05-18", values: { opus: 2100, gpt: 1100, sonnet: 820 } },
  { date: "2026-06-01", values: { opus: 2600, gpt: 1200, sonnet: 900 } },
  { date: "2026-06-15", values: { opus: 3000, gpt: 1500, sonnet: 980 } },
  { date: "2026-06-29", values: { opus: 3400, gpt: 1700, sonnet: 1050 } },
  { date: "2026-07-13", values: { opus: 3900, gpt: 1900, sonnet: 1180 } },
  { date: "2026-07-27", values: { opus: 4300, gpt: 2100, sonnet: 1260 } },
];

export const prTrendSeries: TimeSeriesSeriesDef[] = [
  { key: "merged", label: "Merged PRs" },
];

export const prTrendPoints: TimeSeriesPointDatum[] = [
  { date: "2026-05-04", values: { merged: 14 } },
  { date: "2026-05-18", values: { merged: 19 } },
  { date: "2026-06-01", values: { merged: 22 } },
  { date: "2026-06-15", values: { merged: 28 } },
  { date: "2026-06-29", values: { merged: 31 } },
  { date: "2026-07-13", values: { merged: 38 } },
  { date: "2026-07-27", values: { merged: 44 } },
];

export type RangeKey = "7d" | "30d" | "90d" | "all";

type MetricRow = {
  label: string;
  value: string;
  delta: number;
  deltaPolarity: MetricPolarity;
  requiresGitHub?: boolean;
};

// Per-range metric snapshots for the "me" scope.
export const meMetricsByRange: Record<RangeKey, MetricRow[]> = {
  "7d": [
    {
      label: "Sessions",
      value: "369",
      delta: 7,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$2,844",
      delta: -3,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "16",
      delta: 14,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "208 lines",
      delta: -1,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "3.1",
      delta: 9,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  "30d": [
    {
      label: "Sessions",
      value: "1,511",
      delta: 8,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$12,450",
      delta: -5,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "72",
      delta: 11,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "211 lines",
      delta: -2,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "13.8",
      delta: 4,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  "90d": [
    {
      label: "Sessions",
      value: "4,695",
      delta: 12,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$36,412",
      delta: 8,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "212",
      delta: 19,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "214 lines",
      delta: -4,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "42.1",
      delta: 6,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  all: [
    {
      label: "Sessions",
      value: "11,240",
      delta: 18,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$87,390",
      delta: 12,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "518",
      delta: 24,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "217 lines",
      delta: -3,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "101.4",
      delta: 15,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
};

// Per-range metric snapshots for the "org" scope (~5 engineers).
export const orgMetricsByRange: Record<RangeKey, MetricRow[]> = {
  "7d": [
    {
      label: "Sessions",
      value: "1,830",
      delta: 5,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$14,240",
      delta: -2,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "82",
      delta: 9,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "196 lines",
      delta: -1,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "15.7",
      delta: 6,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  "30d": [
    {
      label: "Sessions",
      value: "7,420",
      delta: 6,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$59,610",
      delta: 3,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "342",
      delta: 14,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "199 lines",
      delta: -2,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "64.2",
      delta: 8,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  "90d": [
    {
      label: "Sessions",
      value: "22,340",
      delta: 11,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$172,840",
      delta: 9,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "1,047",
      delta: 21,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "201 lines",
      delta: -3,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "201.2",
      delta: 7,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
  all: [
    {
      label: "Sessions",
      value: "54,210",
      delta: 21,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Cost",
      value: "$418,200",
      delta: 14,
      deltaPolarity: MetricPolarity.LowerIsBetter,
    },
    {
      label: "Merged PRs",
      requiresGitHub: true,
      value: "2,564",
      delta: 28,
      deltaPolarity: MetricPolarity.HigherIsBetter,
    },
    {
      label: "Median PR size",
      value: "204 lines",
      delta: -2,
      deltaPolarity: MetricPolarity.Neutral,
    },
    {
      label: "KLOC merged",
      requiresGitHub: true,
      value: "493.6",
      delta: 11,
      deltaPolarity: MetricPolarity.Neutral,
    },
  ],
};

// Sessions showing teammates — only visible in the org scope (signed-in state).
export const orgSessions: readonly ActivityRow[] = [
  {
    id: "ses-351",
    title: "API rate limiting",
    subtitle: "maya · Claude · 28m",
    value: "163 lines/$",
    status: ActivityStatus.Merged,
  },
  {
    id: "ses-350",
    title: "Auth token refresh",
    subtitle: "sam · Codex · 44m",
    value: "119 lines/$",
    status: ActivityStatus.InReview,
  },
  {
    id: "ses-349",
    title: "Checkout retry handling",
    subtitle: "you · Codex · 34m",
    value: "142 lines/$",
    status: ActivityStatus.Merged,
  },
  {
    id: "ses-348",
    title: "Permissions audit",
    subtitle: "devon · Claude · 51m",
    value: "128 lines/$",
    status: ActivityStatus.InReview,
  },
];

// AI Impact metrics for the org scope.
export const orgAiImpactMetrics: readonly AiImpactMetricRow[] = [
  {
    key: "cost-per-pr",
    label: "Cost per merged PR",
    value: "$165",
    detail: "Estimated cost ÷ PRs shipped",
    requiresGitHub: true,
  },
  {
    key: "tokens-per-kloc",
    label: "Tokens per KLOC",
    value: "52K",
    detail: "Tokens ÷ thousands of lines merged",
    requiresGitHub: true,
  },
  {
    key: "top-model",
    label: "Top model by cost",
    value: "Claude Opus",
    detail: "29% of cost",
    requiresGitHub: false,
  },
  {
    key: "top-repo",
    label: "Top repo by output",
    value: "api-service",
    detail: "127 merged PRs",
    requiresGitHub: true,
  },
];

export const heatmapWeeks: AnalyticsHeatmapWeek[] = Array.from(
  { length: 13 },
  (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date("2026-05-03T00:00:00Z");
      const index = weekIndex * 7 + dayIndex;
      date.setUTCDate(date.getUTCDate() + index);
      const weekend = dayIndex === 0 || dayIndex === 6;
      const base = weekend ? 2 : 9;
      return {
        date: date.toISOString().slice(0, 10),
        count: base + ((index * 7) % 13) + (weekIndex % 4) * 2,
      };
    })
);
