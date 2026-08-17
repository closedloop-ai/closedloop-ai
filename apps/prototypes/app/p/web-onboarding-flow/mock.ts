import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import type { AnalyticsHeatmapWeek } from "@repo/design-system/components/ui/types";

// Landing hero — mirrors the pre-auth-desktop-onboarding landing. The colored
// "burning" word is composed in the h1 markup, so the headline is not a data
// field here.
export const heroCopy = {
  subtitle:
    "We parse your agent sessions and show you where spend goes, what’s working, and how to build more efficiently.",
  primaryCta: "Get Started",
  signInPrompt: "Already have an account?",
  signInCta: "Sign in",
} as const;

// The auth page has a sign-up and a sign-in mode. A new visitor arriving from
// the landing "Get Started" opens on sign-up; the footer switches modes rather
// than firing an auth handoff. Copy and button labels differ per mode; the
// GitHub-first hierarchy is shared.
export const AuthMode = {
  SignUp: "sign-up",
  SignIn: "sign-in",
} as const;
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

export type AuthCopy = {
  path: string;
  heading: string;
  githubCta: string;
  googleCta: string;
  emailLabel: string;
  emailPlaceholder: string;
  submitCta: string;
  switchPrompt: string;
  switchCta: string;
};

export const authCopy: Record<AuthMode, AuthCopy> = {
  [AuthMode.SignUp]: {
    path: "app.closedloop.ai/sign-up",
    heading: "Create your account",
    githubCta: "Sign up with GitHub",
    googleCta: "Sign up with Google",
    emailLabel: "Email address",
    emailPlaceholder: "Enter your email address",
    submitCta: "Sign up",
    switchPrompt: "Already have an account?",
    switchCta: "Sign in",
  },
  [AuthMode.SignIn]: {
    path: "app.closedloop.ai/sign-in",
    heading: "Welcome back",
    githubCta: "Continue with GitHub",
    googleCta: "Continue with Google",
    emailLabel: "Email address",
    emailPlaceholder: "Enter your email address",
    submitCta: "Sign in",
    switchPrompt: "Don't have an account?",
    switchCta: "Sign up",
  },
};

// Which way in the user chose on the auth page. Threaded to the hand-off
// screen so it names the actual provider instead of hardcoding GitHub.
export const AuthProvider = {
  GitHub: "github",
  Google: "google",
  Email: "email",
} as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];

export const AppRoute = {
  MyTasks: "my-tasks",
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  Settings: "settings",
} as const;
export type AppRoute = (typeof AppRoute)[keyof typeof AppRoute];

export const NavIconName = {
  Branches: "branches",
  Dashboard: "dashboard",
  MyTasks: "my-tasks",
  Sessions: "sessions",
} as const;
export type NavIconName = (typeof NavIconName)[keyof typeof NavIconName];

export const navItems = [
  {
    label: "My Tasks",
    route: AppRoute.MyTasks,
    icon: NavIconName.MyTasks,
  },
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

export const modelUsageSeries: TimeSeriesSeriesDef[] = [
  { key: "opus", label: "Claude Opus" },
  { key: "gpt", label: "GPT-5.5" },
  { key: "sonnet", label: "Claude Sonnet" },
];

export const prTrendSeries: TimeSeriesSeriesDef[] = [
  { key: "merged", label: "Merged PRs" },
];

export type RangeKey = "7d" | "30d" | "90d" | "all";

export type DashboardScope = "me" | "org";

// Range and scope drive the charts, not just the KPI row: the range picks the
// time window (and how many points it samples) and the scope sets the magnitude
// band (a single engineer vs the whole org). Values are synthetic window series,
// not a cumulative total scaled by a range multiplier.
const CHART_WINDOWS: Record<RangeKey, { points: number; stepDays: number }> = {
  "7d": { points: 7, stepDays: 1 },
  "30d": { points: 6, stepDays: 5 },
  "90d": { points: 7, stepDays: 14 },
  all: { points: 8, stepDays: 30 },
};

const CHART_WINDOW_END = "2026-07-27";

// Ascending ISO dates for a range's window, ending at CHART_WINDOW_END.
function chartWindowDates(range: RangeKey): string[] {
  const { points, stepDays } = CHART_WINDOWS[range];
  const end = new Date(`${CHART_WINDOW_END}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = points - 1; i >= 0; i -= 1) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - i * stepDays);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

type SeriesBand = { base: number; growth: number };

const MODEL_BANDS: Record<DashboardScope, Record<string, SeriesBand>> = {
  me: {
    opus: { base: 1800, growth: 420 },
    gpt: { base: 900, growth: 200 },
    sonnet: { base: 700, growth: 95 },
  },
  org: {
    opus: { base: 4300, growth: 1080 },
    gpt: { base: 2100, growth: 520 },
    sonnet: { base: 1600, growth: 240 },
  },
};

export function modelUsagePointsFor(
  range: RangeKey,
  scope: DashboardScope
): TimeSeriesPointDatum[] {
  const bands = MODEL_BANDS[scope];
  return chartWindowDates(range).map((date, index) => ({
    date,
    values: {
      opus: Math.round(bands.opus.base + bands.opus.growth * index),
      gpt: Math.round(bands.gpt.base + bands.gpt.growth * index),
      sonnet: Math.round(bands.sonnet.base + bands.sonnet.growth * index),
    },
  }));
}

const PR_BANDS: Record<DashboardScope, SeriesBand> = {
  me: { base: 14, growth: 5 },
  org: { base: 68, growth: 22 },
};

export function prTrendPointsFor(
  range: RangeKey,
  scope: DashboardScope
): TimeSeriesPointDatum[] {
  const band = PR_BANDS[scope];
  return chartWindowDates(range).map((date, index) => ({
    date,
    values: { merged: Math.round(band.base + band.growth * index) },
  }));
}

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

// Sessions showing teammates — visible in the org scope.
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

// Number of weeks the heatmap shows per range, and per-scope weekday/weekend
// base event counts (more engineers in the org scope means more events a day).
const HEATMAP_WEEKS: Record<RangeKey, number> = {
  "7d": 1,
  "30d": 5,
  "90d": 13,
  all: 26,
};

const HEATMAP_BASE: Record<
  DashboardScope,
  { weekday: number; weekend: number }
> = {
  me: { weekday: 9, weekend: 2 },
  org: { weekday: 24, weekend: 6 },
};

export function buildHeatmapWeeks(
  range: RangeKey,
  scope: DashboardScope
): AnalyticsHeatmapWeek[] {
  const weeks = HEATMAP_WEEKS[range];
  const bands = HEATMAP_BASE[scope];
  // End on the week containing CHART_WINDOW_END so the heatmap and the charts
  // share the same right edge.
  const end = new Date(`${CHART_WINDOW_END}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (weeks - 1) * 7 - end.getUTCDay());
  return Array.from({ length: weeks }, (_, weekIndex) =>
    Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(start);
      const index = weekIndex * 7 + dayIndex;
      date.setUTCDate(date.getUTCDate() + index);
      const weekend = dayIndex === 0 || dayIndex === 6;
      const base = weekend ? bands.weekend : bands.weekday;
      return {
        date: date.toISOString().slice(0, 10),
        count: base + ((index * 7) % 13) + (weekIndex % 4) * 2,
      };
    })
  );
}

// Settings surface the checklist deep-links into. Tab ids mirror the production
// SettingsTab wire values so the prototype reads like the real routes.
export const SettingsTab = {
  Profile: "profile",
  Organization: "organization",
  Integrations: "integrations",
  ApiKeys: "api-keys",
} as const;
export type SettingsTab = (typeof SettingsTab)[keyof typeof SettingsTab];

export const SettingsTabLabel: Record<SettingsTab, string> = {
  [SettingsTab.Profile]: "Profile",
  [SettingsTab.Organization]: "Organization",
  [SettingsTab.Integrations]: "Compute & Integrations",
  [SettingsTab.ApiKeys]: "API Keys",
};

// Side sections within the Organization tab (mirrors the org profile side nav).
export const OrgSettingsSection = {
  General: "general",
  Members: "members",
} as const;
export type OrgSettingsSection =
  (typeof OrgSettingsSection)[keyof typeof OrgSettingsSection];

// DOM ids the integration deep-links scroll to. "anthropic-api-key" matches the
// production ANTHROPIC_API_KEY_CARD_ANCHOR.
export const GITHUB_CARD_ANCHOR = "github";
export const ANTHROPIC_API_KEY_CARD_ANCHOR = "anthropic-api-key";

// Where a checklist row sends the user: a Settings tab, optionally scrolled to a
// card anchor or opened on an Organization side section.
export type SettingsTarget = {
  tab: SettingsTab;
  anchor?: string;
  orgSection?: OrgSettingsSection;
};

export type OrgMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
};

// A freshly-created org has just the owner until invites are accepted.
export const orgMembers: readonly OrgMember[] = [
  {
    id: "member-you",
    name: "Kaiti",
    email: "kaiti@acme.dev",
    role: "Owner",
    initials: "KC",
  },
];

// The "Complete Your Setup" checklist shown on My Tasks in prod. Google Drive
// is behind a flag (off by default), so it is not listed here. The Set-up-AI-
// agents card (AgentOnboardingCard) is intentionally omitted per the brief.
export const ChecklistItemId = {
  CreateTeam: "create-team",
  CreateProject: "create-project",
  DownloadDesktop: "download-desktop",
  ConnectGitHub: "connect-github",
  AddAnthropicKey: "add-anthropic-key",
  InviteMembers: "invite-members",
} as const;
export type ChecklistItemId =
  (typeof ChecklistItemId)[keyof typeof ChecklistItemId];

export type ChecklistItem = {
  id: ChecklistItemId;
  label: string;
  description: string;
  completed: boolean;
  // Incomplete items deep-link into Settings; completed items are static.
  target?: SettingsTarget;
};

// State after the wizard: team and project just created (done), the rest still
// open. That makes the "Invite team members" row the natural next action the
// spotlight points at.
export const onboardingChecklist: readonly ChecklistItem[] = [
  {
    id: ChecklistItemId.CreateTeam,
    label: "Create a team",
    description: "Set up your first team to organize projects",
    completed: true,
  },
  {
    id: ChecklistItemId.CreateProject,
    label: "Create a project",
    description: "Start your first project within a team",
    completed: true,
  },
  {
    id: ChecklistItemId.DownloadDesktop,
    label: "Download the desktop app",
    description: "Install Closedloop Desktop to analyze your agent sessions",
    completed: false,
  },
  {
    id: ChecklistItemId.ConnectGitHub,
    label: "Connect GitHub",
    description: "Link your repositories for code management",
    completed: false,
    target: { tab: SettingsTab.Integrations, anchor: GITHUB_CARD_ANCHOR },
  },
  {
    id: ChecklistItemId.AddAnthropicKey,
    label: "Add Anthropic API key",
    description: "Required for AI-powered workflows",
    completed: false,
    target: {
      tab: SettingsTab.Integrations,
      anchor: ANTHROPIC_API_KEY_CARD_ANCHOR,
    },
  },
  {
    id: ChecklistItemId.InviteMembers,
    label: "Invite team members",
    description: "Add colleagues to your organization",
    completed: false,
    target: {
      tab: SettingsTab.Organization,
      orgSection: OrgSettingsSection.Members,
    },
  },
];
