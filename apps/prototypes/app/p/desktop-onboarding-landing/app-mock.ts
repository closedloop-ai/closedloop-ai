// App-phase mock data for the fleshed-out first-run flow (the surfaces shown
// after "Get started"). Shapes mirror the desktop-onboarding prototype and the
// production renderer so the presentational stubs read as the real app. Kept
// separate from the landing copy in mock.ts to keep each file focused.

import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import type {
  AnalyticsHeatmapWeek,
  Tone,
} from "@repo/design-system/components/ui/types";

export type AppRoute = "dashboard" | "sessions" | "branches";

export type NavIconName = "dashboard" | "sessions" | "branches";

export type NavItem = {
  route: AppRoute;
  label: string;
  icon: NavIconName;
};

// Sidebar count badges are driven live from the parse-progress snapshot in
// AppExperience, not from static values here (r3706995125).
export const navItems: readonly NavItem[] = [
  { route: "dashboard", label: "Dashboard", icon: "dashboard" },
  { route: "sessions", label: "Sessions", icon: "sessions" },
  { route: "branches", label: "Branches", icon: "branches" },
];

export const routeTitles: Record<AppRoute, string> = {
  dashboard: "Dashboard",
  sessions: "Sessions",
  branches: "Branches",
};

export type StatDatum = {
  key: string;
  label: string;
  value: string;
  delta: number;
  deltaPolarity: MetricPolarity;
  detail: string;
  unitLabel?: string;
  info: { what: string; how?: string };
};

// Mirrors the prod dashboard stats row (kpi:sessions, kpi:cost, kpi:merged,
// kpi:pr-size, kpi:kloc): same titles, unit labels, and info copy.
export const stats: readonly StatDatum[] = [
  {
    key: "sessions",
    label: "Sessions",
    value: "4,695",
    delta: 12,
    deltaPolarity: MetricPolarity.HigherIsBetter,
    detail: "vs. prior period",
    info: {
      what: "Agent sessions run in the period.",
      how: "Counts agent sessions started in the range.",
    },
  },
  {
    key: "cost",
    label: "Cost",
    value: "$36,412",
    delta: 8,
    deltaPolarity: MetricPolarity.LowerIsBetter,
    detail: "vs. prior period",
    info: {
      what: "Estimated model spend in the period.",
      how: "Sum of estimated cost across agent sessions in range.",
    },
  },
  {
    key: "merged",
    label: "Merged PRs",
    value: "212",
    delta: 19,
    deltaPolarity: MetricPolarity.HigherIsBetter,
    detail: "vs. prior period",
    info: {
      what: "Pull requests merged in the selected period.",
      how: "Counts PRs whose merge date falls in the range.",
    },
  },
  {
    key: "pr-size",
    label: "Median PR size",
    value: "214",
    delta: -4,
    deltaPolarity: MetricPolarity.LowerIsBetter,
    detail: "vs. prior period",
    unitLabel: "lines",
    info: {
      what: "Median size of a merged PR.",
      how: "Median of additions + deletions per merged branch.",
    },
  },
  {
    key: "kloc",
    label: "KLOC merged",
    value: "42.1",
    delta: 6,
    deltaPolarity: MetricPolarity.HigherIsBetter,
    detail: "vs. prior period",
    unitLabel: "KLOC",
    info: {
      what: "Thousands of lines merged in the period.",
      how: "Sum of additions + deletions across merged branches, divided by 1,000.",
    },
  },
];

export type AiImpactMetric = {
  key: string;
  label: string;
  value: string;
  detail: string;
};

export const aiImpactMetrics: readonly AiImpactMetric[] = [
  {
    key: "cost-per-pr",
    label: "Cost per merged PR",
    value: "$172",
    detail: "Model spend / PRs shipped",
  },
  {
    key: "tokens-per-kloc",
    label: "Tokens per KLOC",
    value: "48.9K",
    detail: "Tokens / thousands of lines merged",
  },
  {
    key: "top-model",
    label: "Top model by spend",
    value: "Claude Opus",
    detail: "58% of spend",
  },
  {
    key: "top-repo",
    label: "Top repo by output",
    value: "web-app",
    detail: "96 merged PRs",
  },
];

const chartDates = [
  "2026-05-04",
  "2026-05-18",
  "2026-06-01",
  "2026-06-15",
  "2026-06-29",
  "2026-07-13",
  "2026-07-27",
] as const;

const buildPoints = (
  rows: readonly Record<string, number>[]
): TimeSeriesPointDatum[] =>
  chartDates.map((date, index) => ({ date, values: rows[index] }));

export const activitySeries: readonly TimeSeriesSeriesDef[] = [
  { key: "agent", label: "Agent" },
  { key: "human", label: "Human" },
];

export const activityPoints: readonly TimeSeriesPointDatum[] = buildPoints([
  { agent: 210, human: 120 },
  { agent: 260, human: 140 },
  { agent: 330, human: 150 },
  { agent: 410, human: 160 },
  { agent: 520, human: 150 },
  { agent: 610, human: 170 },
  { agent: 720, human: 165 },
]);

export const modelUsageSeries: readonly TimeSeriesSeriesDef[] = [
  { key: "opus", label: "Claude Opus" },
  { key: "gpt", label: "GPT-5.5" },
  { key: "sonnet", label: "Claude Sonnet" },
];

export const modelUsagePoints: readonly TimeSeriesPointDatum[] = buildPoints([
  { opus: 1800, gpt: 900, sonnet: 700 },
  { opus: 2100, gpt: 1100, sonnet: 820 },
  { opus: 2600, gpt: 1200, sonnet: 900 },
  { opus: 3000, gpt: 1500, sonnet: 980 },
  { opus: 3400, gpt: 1700, sonnet: 1050 },
  { opus: 3900, gpt: 1900, sonnet: 1180 },
  { opus: 4300, gpt: 2100, sonnet: 1260 },
]);

export type CategoryRow = {
  key: string;
  label: string;
  value: number;
};

export const modelBreakdown: readonly CategoryRow[] = [
  { key: "opus", label: "Claude Opus", value: 21_100 },
  { key: "gpt", label: "GPT-5.5", value: 9400 },
  { key: "sonnet", label: "Claude Sonnet", value: 5900 },
  { key: "gemini", label: "Gemini 2.5", value: 2100 },
];

export const teamBreakdown: readonly CategoryRow[] = [
  { key: "you", label: "You", value: 118 },
  { key: "median", label: "Team median", value: 96 },
  { key: "top", label: "Top teammate", value: 142 },
  { key: "org", label: "Org median", value: 88 },
];

export const prTrendSeries: readonly TimeSeriesSeriesDef[] = [
  { key: "merged", label: "Merged PRs" },
];

export const prTrendPoints: readonly TimeSeriesPointDatum[] = buildPoints([
  { merged: 14 },
  { merged: 19 },
  { merged: 22 },
  { merged: 28 },
  { merged: 31 },
  { merged: 38 },
  { merged: 44 },
]);

export const prByRepo: readonly CategoryRow[] = [
  { key: "web-app", label: "web-app", value: 96 },
  { key: "api", label: "api", value: 61 },
  { key: "desktop", label: "desktop", value: 38 },
  { key: "infra", label: "infra", value: 17 },
];

// A compact agent-collaboration graph for the pipeline row: a left-to-right
// flow of the roles agents played, with hand-off counts.
export type PipelineNode = {
  id: string;
  label: string;
  sessions: number;
};

export const pipelineNodes: readonly PipelineNode[] = [
  { id: "plan", label: "Planner", sessions: 512 },
  { id: "code", label: "Coder", sessions: 1840 },
  { id: "review", label: "Reviewer", sessions: 906 },
  { id: "ship", label: "Shipper", sessions: 412 },
];

// Event-activity heatmap weeks (Sun-started), generated deterministically so the
// grid looks lived-in without any randomness.
const pad = (n: number) => String(n).padStart(2, "0");

const isoAddDays = (baseIso: string, days: number): string => {
  const date = new Date(`${baseIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

const buildHeatmapWeeks = (weekCount: number): AnalyticsHeatmapWeek[] => {
  const start = "2026-05-03"; // a Sunday
  const weeks: AnalyticsHeatmapWeek[] = [];
  for (let w = 0; w < weekCount; w++) {
    const week: { date: string; count: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const index = w * 7 + d;
      const weekend = d === 0 || d === 6;
      const base = weekend ? 2 : 9;
      const count = base + ((index * 7) % 13) + (w % 4) * 2;
      week.push({ date: isoAddDays(start, index), count });
    }
    weeks.push(week);
  }
  return weeks;
};

export const heatmapWeeks: readonly AnalyticsHeatmapWeek[] =
  buildHeatmapWeeks(13);

export type SessionRow = {
  id: string;
  name: string;
  repo: string;
  model: string;
  cost: string;
  when: string;
  statusLabel: string;
  statusTone: Tone;
  pulse?: boolean;
};

export const recentSessions: readonly SessionRow[] = [
  {
    id: "s1",
    name: "Refactor auth middleware",
    repo: "web-app",
    model: "claude-opus-4-8",
    cost: "$4.12",
    when: "2m ago",
    statusLabel: "Running",
    statusTone: "accent",
    pulse: true,
  },
  {
    id: "s2",
    name: "Add saved-view bulk actions",
    repo: "web-app",
    model: "gpt-5.5",
    cost: "$2.80",
    when: "18m ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "s3",
    name: "Fix flaky ingest test",
    repo: "desktop",
    model: "claude-sonnet-4-6",
    cost: "$0.94",
    when: "1h ago",
    statusLabel: "In review",
    statusTone: "info",
  },
  {
    id: "s4",
    name: "Migrate job queue",
    repo: "api",
    model: "claude-opus-4-8",
    cost: "$6.31",
    when: "3h ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "s5",
    name: "Draft webhook retry policy",
    repo: "api",
    model: "gpt-5.5",
    cost: "$1.55",
    when: "5h ago",
    statusLabel: "Abandoned",
    statusTone: "muted",
  },
  {
    id: "s6",
    name: "Tune classifier thresholds",
    repo: "desktop",
    model: "claude-opus-4-8",
    cost: "$3.02",
    when: "yesterday",
    statusLabel: "Needs input",
    statusTone: "warning",
  },
];

export type BranchRow = {
  id: string;
  branch: string;
  pr: string;
  repo: string;
  size: string;
  when: string;
  statusLabel: string;
  statusTone: Tone;
};

export const branchRows: readonly BranchRow[] = [
  {
    id: "b1",
    branch: "feat/auth-middleware",
    pr: "#3912",
    repo: "web-app",
    size: "+412 / -88",
    when: "2m ago",
    statusLabel: "Open",
    statusTone: "accent",
  },
  {
    id: "b2",
    branch: "feat/bulk-actions",
    pr: "#3905",
    repo: "web-app",
    size: "+220 / -34",
    when: "18m ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "b3",
    branch: "fix/flaky-ingest",
    pr: "#3903",
    repo: "desktop",
    size: "+64 / -12",
    when: "1h ago",
    statusLabel: "In review",
    statusTone: "info",
  },
  {
    id: "b4",
    branch: "chore/job-queue",
    pr: "#3899",
    repo: "api",
    size: "+980 / -240",
    when: "3h ago",
    statusLabel: "Merged",
    statusTone: "success",
  },
  {
    id: "b5",
    branch: "spike/webhook-retry",
    pr: "no PR yet",
    repo: "api",
    size: "+120 / -0",
    when: "5h ago",
    statusLabel: "Net-new",
    statusTone: "muted",
  },
];

export const branchSummary: readonly StatDatum[] = [
  {
    key: "branches",
    label: "Branches",
    value: "128",
    delta: 9,
    deltaPolarity: MetricPolarity.Neutral,
    detail: "last 90 days",
    info: { what: "Branches active in the selected window." },
  },
  {
    key: "merged",
    label: "PRs merged",
    value: "212",
    delta: 19,
    deltaPolarity: MetricPolarity.HigherIsBetter,
    detail: "last 90 days",
    info: { what: "Pull requests merged from these branches." },
  },
  {
    key: "median",
    label: "Median PR size",
    value: "+186 / -42",
    delta: -4,
    deltaPolarity: MetricPolarity.LowerIsBetter,
    detail: "lines changed",
    info: { what: "Median additions and deletions per merged PR." },
  },
  {
    key: "cost",
    label: "Cost / merged PR",
    value: "$172",
    delta: -7,
    deltaPolarity: MetricPolarity.LowerIsBetter,
    detail: "last 90 days",
    info: { what: "Average agent spend per merged pull request." },
  },
];

export const sessionsTotal = 4695;

export const branchesTotal = 128;

// The scan summary shown in the first tour card: sessions parsed, the harnesses
// detected (with validation status), and the models seen across them.
export type TourChip = {
  text: string;
  ok?: boolean;
  warn?: boolean;
  muted?: boolean;
};

export type TourSummaryRow = {
  key: string;
  icon: "sessions" | "harnesses" | "models";
  label: string;
  value?: string;
  sub?: string;
  chips?: readonly TourChip[];
};

export const tourSummary: readonly TourSummaryRow[] = [
  {
    key: "sessions",
    icon: "sessions",
    label: "Sessions parsed",
    value: "4,695",
    sub: "total detected",
  },
  {
    key: "harnesses",
    icon: "harnesses",
    label: "Harnesses found",
    chips: [
      { text: "Claude Code", ok: true },
      { text: "Codex", ok: true },
      { text: "Gemini CLI", warn: true },
    ],
    sub: "Only Claude Code and Codex are validated harnesses. Anything else is read on a best-effort basis.",
  },
  {
    key: "models",
    icon: "models",
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

// Guided-tour steps. Intro is a centered card; the rest spotlight a dashboard
// section via its data-tour target. The last step's primary action drives the
// account CTA rather than "Done".
export type TourStep = {
  id: string;
  eyebrow?: string;
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
    body: "All your agent session logs have been parsed and analyzed. Closedloop shows you your AI stats like cost, value, efficiency and so much more showing you where there's room for improvement.",
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
    title: "When the Work Happens",
    body: "Each agent run and human input heatmapped across time.",
    target: "activity",
  },
  {
    id: "models",
    eyebrow: "Models",
    title: "Model Breakdown",
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
];

export type SignUpContext = "tour" | "organization" | "invite" | "header";

export type SignUpCopy = {
  eyebrow?: string;
  title: string;
  body: string;
};

export const signUpCopy: Record<SignUpContext, SignUpCopy> = {
  tour: {
    title: "Create your account",
    body: "Sign up to see how your team uses AI, unlock org-wide insights, and sync across devices. You decide what syncs versus stays local.",
  },
  organization: {
    eyebrow: "Organization view",
    title: "Organization scope needs an account",
    body: "Sign up to switch from just you to your whole organization and see how everyone's agents are performing.",
  },
  invite: {
    eyebrow: "Bring your team",
    title: "Invite your team",
    body: "Sign up to create your organization and invite teammates. They'll see shared insights the moment they join.",
  },
  header: {
    eyebrow: "Your account",
    title: "Create your Closedloop account",
    body: "Sign up to compare with your team, unlock org insights, and pick up across devices.",
  },
};

export const currency = (value: number) => `$${value.toLocaleString("en-US")}`;
