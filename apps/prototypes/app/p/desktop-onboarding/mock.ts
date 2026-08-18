// Mock data for the Desktop Onboarding prototype. Presentational only — no
// fetch, env, or persistence (see apps/prototypes/README.md). Ported from the
// Claude Design handoff "Desktop Onboarding" project. The product intent: the
// desktop app opens straight to a local-first dashboard, runs a guided tour,
// and only asks for an account when the user reaches for something that needs
// identity (sync / export / share / team comparison). Account creation is
// GitHub-first: GitHub OAuth mints the Clerk identity AND yields a scoped
// GitHub API token, so we never invasively drive the user's local gh/git.

import type {
  TimeSeriesPointDatum,
  TimeSeriesSeriesDef,
} from "@repo/design-system/components/ui/time-series-area-chart";
import type { Tone } from "@repo/design-system/components/ui/types";

// ── Headline KPI tiles ──────────────────────────────────────────────────
export type StatDatum = {
  key: string;
  label: string;
  value: string;
  delta: number;
  detail: string;
  info: { what: string; how?: string };
};

export const stats: readonly StatDatum[] = [
  {
    key: "sessions",
    label: "Sessions analyzed",
    value: "4,695",
    delta: 8,
    detail: "found on this Mac",
    info: {
      what: "Agent sessions parsed from local harness logs.",
      how: "Counted across Claude Code and Codex session files on this device.",
    },
  },
  {
    key: "cost",
    label: "Token spend",
    value: "$36,412",
    delta: 14,
    detail: "estimated, all-time",
    info: { what: "Estimated model spend across all analyzed sessions." },
  },
  {
    key: "prs",
    label: "PRs shipped",
    value: "1,284",
    delta: 18,
    detail: "merged from agent work",
    info: { what: "Merged pull requests attributed to agent sessions." },
  },
  {
    key: "pr-size",
    label: "Median PR size",
    value: "184",
    delta: -6,
    detail: "lines changed",
    info: { what: "Median lines changed per merged PR." },
  },
  {
    key: "loc-per-dollar",
    label: "LOC / $",
    value: "6.5",
    delta: 9,
    detail: "merged lines per dollar",
    info: { what: "Merged lines shipped per dollar of spend." },
  },
];

// ── Recent sessions table ───────────────────────────────────────────────
export type RecentSession = {
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

// Repeats statuses the way a real log does (a couple of Completed, a couple
// Running, one Blocked) instead of one-of-each — a distinct tone per row reads
// as a swatch, not a session log (#4285 T16).
export const recentSessions: readonly RecentSession[] = [
  {
    id: "s1",
    name: "Refactor billing webhooks",
    repo: "api",
    model: "claude-opus-4-7",
    cost: "$4.12",
    when: "2h ago",
    statusLabel: "Deployed",
    statusTone: "success",
  },
  {
    id: "s2",
    name: "Add OAuth device flow",
    repo: "auth",
    model: "gpt-5.5",
    cost: "$2.80",
    when: "5h ago",
    statusLabel: "In review",
    statusTone: "info",
  },
  {
    id: "s3",
    name: "Migrate repositoryOverrides",
    repo: "core",
    model: "claude-sonnet-4-6",
    cost: "$1.94",
    when: "Yesterday",
    statusLabel: "Completed",
    statusTone: "muted",
  },
  {
    id: "s4",
    name: "Fix flaky e2e suite",
    repo: "web",
    model: "claude-opus-4-7",
    cost: "$3.41",
    when: "Yesterday",
    statusLabel: "Running",
    statusTone: "accent",
    pulse: true,
  },
  {
    id: "s5",
    name: "Optimize bundle splitting",
    repo: "web",
    model: "gpt-5.5",
    cost: "$0.96",
    when: "2d ago",
    statusLabel: "Merging",
    statusTone: "info",
  },
  {
    id: "s6",
    name: "Draft Q3 perf report",
    repo: "docs",
    model: "claude-haiku-4-5",
    cost: "$0.22",
    when: "3d ago",
    statusLabel: "Completed",
    statusTone: "muted",
  },
  {
    id: "s7",
    name: "Patch CVE in deps",
    repo: "infra",
    model: "gpt-5.4",
    cost: "$1.10",
    when: "4d ago",
    statusLabel: "Blocked",
    statusTone: "danger",
  },
  {
    id: "s8",
    name: "Tidy design tokens",
    repo: "design-system",
    model: "claude-sonnet-4-6",
    cost: "$0.74",
    when: "5d ago",
    statusLabel: "Running",
    statusTone: "accent",
    pulse: true,
  },
];

// ── Weekly time-series buckets (last ~90 days) ──────────────────────────
const weeks: readonly string[] = [
  "2026-04-13",
  "2026-04-20",
  "2026-04-27",
  "2026-05-04",
  "2026-05-11",
  "2026-05-18",
  "2026-05-25",
  "2026-06-01",
  "2026-06-08",
  "2026-06-15",
  "2026-06-22",
  "2026-06-29",
  "2026-07-06",
  "2026-07-13",
];

const buildPoints = (
  seriesValues: Record<string, readonly number[]>
): TimeSeriesPointDatum[] =>
  weeks.map((date, index) => {
    const values: Record<string, number> = {};
    for (const [key, series] of Object.entries(seriesValues)) {
      values[key] = series[index] ?? 0;
    }
    return { date, values };
  });

// Activity — agent runs vs human input, plotted over the last 90 days.
export const activitySeries: readonly TimeSeriesSeriesDef[] = [
  { key: "agent", label: "Agent" },
  { key: "human", label: "Human" },
];
export const activityPoints: readonly TimeSeriesPointDatum[] = buildPoints({
  agent: [120, 135, 142, 150, 168, 175, 190, 205, 220, 235, 248, 262, 275, 290],
  human: [80, 84, 88, 86, 92, 95, 99, 102, 106, 110, 113, 117, 120, 124],
});

// Model spend over time.
export const modelUsageSeries: readonly TimeSeriesSeriesDef[] = [
  { key: "opus", label: "claude-opus-4-7" },
  { key: "gpt", label: "gpt-5.5" },
  { key: "sonnet", label: "claude-sonnet-4-6" },
];
export const modelUsagePoints: readonly TimeSeriesPointDatum[] = buildPoints({
  opus: [
    1200, 1350, 1420, 1600, 1720, 1810, 1950, 2100, 2240, 2380, 2520, 2680,
    2810, 2960,
  ],
  gpt: [
    640, 700, 760, 720, 880, 940, 1010, 1080, 1160, 1240, 1300, 1380, 1460,
    1540,
  ],
  sonnet: [
    420, 460, 500, 540, 600, 650, 700, 760, 820, 880, 940, 1010, 1080, 1150,
  ],
});

// PR throughput over time (single series).
export const prTrendSeries: readonly TimeSeriesSeriesDef[] = [
  { key: "merged", label: "Merged PRs" },
];
export const prTrendPoints: readonly TimeSeriesPointDatum[] = buildPoints({
  merged: [58, 64, 71, 69, 80, 86, 92, 98, 104, 112, 118, 126, 131, 138],
});

// Autonomy trend (0 = fully manual, 100 = fully agentic).
export const autonomySeries: readonly TimeSeriesSeriesDef[] = [
  { key: "autonomy", label: "Autonomy" },
];
export const autonomyPoints: readonly TimeSeriesPointDatum[] = buildPoints({
  autonomy: [41, 44, 46, 48, 52, 55, 58, 60, 63, 66, 68, 71, 73, 76],
});

// ── Category breakdowns ─────────────────────────────────────────────────
export type CategoryRow = { key: string; label: string; value: number };

export const modelBreakdown: readonly CategoryRow[] = [
  { key: "opus", label: "claude-opus-4-7", value: 12_480 },
  { key: "gpt55", label: "gpt-5.5", value: 8420 },
  { key: "sonnet", label: "claude-sonnet-4-6", value: 6240 },
  { key: "gpt54", label: "gpt-5.4", value: 3180 },
  { key: "haiku", label: "claude-haiku-4-5", value: 1920 },
  { key: "gemini", label: "gemini-2.5-pro", value: 1460 },
];

export const prBreakdown: readonly CategoryRow[] = [
  { key: "api", label: "api", value: 214 },
  { key: "web", label: "web", value: 198 },
  { key: "core", label: "core", value: 176 },
  { key: "auth", label: "auth", value: 142 },
  { key: "infra", label: "infra", value: 118 },
  { key: "docs", label: "docs", value: 96 },
];

// Team comparison — the one chart you can't see without an account. Frosted
// until the user creates an account (and their org-of-one is provisioned).
export const teamBreakdown: readonly CategoryRow[] = [
  { key: "you", label: "You", value: 4695 },
  { key: "priya", label: "Priya", value: 3820 },
  { key: "marcus", label: "Marcus", value: 3110 },
  { key: "dana", label: "Dana", value: 2560 },
  { key: "sam", label: "Sam", value: 1980 },
  { key: "alex", label: "Alex", value: 1440 },
];

// ── Sidebar nav ─────────────────────────────────────────────────────────
export type NavIconName =
  | "dashboard"
  | "sessions"
  | "inbox"
  | "agents"
  | "skills"
  | "models"
  | "documents"
  | "branches";

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard", isActive: true },
  { label: "Sessions", icon: "sessions", count: 4695 },
  { label: "Inbox", icon: "inbox" },
];

export const agentNav: readonly NavItem[] = [
  { label: "Agents", icon: "agents" },
  { label: "Skills", icon: "skills" },
  { label: "Models", icon: "models" },
];

export const artifactsNav: readonly NavItem[] = [
  { label: "Documents", icon: "documents" },
  { label: "Branches", icon: "branches" },
];

// ── Account / auth ──────────────────────────────────────────────────────
// Copy adapts to *why* we're asking. GitHub is always the primary method.
export type AuthTrigger =
  | "stack"
  | "invite"
  | "export"
  | "share"
  | "sync"
  | "unlock"
  | "signin";

export type AuthCopy = { eyebrow: string; title: string; body: string };

export const authCopy: Record<AuthTrigger, AuthCopy> = {
  stack: {
    eyebrow: "Go further",
    title: "See how your team uses AI",
    body: "Create a free account to get more insights about your sessions, invite your teammates, and compare how AI is used across your org.",
  },
  invite: {
    eyebrow: "Bring your team in",
    title: "Invite your team",
    body: "Create a free account with GitHub to get deeper insights into your own sessions, invite your teammates, and compare how AI is used across your org.",
  },
  export: {
    eyebrow: "Export your report",
    title: "Create a free account to export",
    body: "Exporting bundles these metrics into a shareable report. Sign up with GitHub to download it and keep it attributed to you.",
  },
  share: {
    eyebrow: "Share with your team",
    title: "Create a free account to share",
    body: "Teammates need a link they can trust. Sign up with GitHub to publish a read-only report and pull the team in.",
  },
  sync: {
    eyebrow: "Sync across machines",
    title: "Create a free account to sync",
    body: "Your analytics live on this device right now. Sign up with GitHub to sync them across machines and keep a running history.",
  },
  unlock: {
    eyebrow: "Full access",
    title: "Create a free account to continue",
    body: "You're exploring as a guest. Sign up with GitHub to sync, export, and share. Everything you've analyzed comes with you.",
  },
  signin: {
    eyebrow: "Welcome back",
    title: "Sign in to ClosedLoop",
    body: "Pick up your synced sessions, history, and team reports where you left off.",
  },
};

// ── Local-vs-synced status copy ─────────────────────────────────────────
// The header pill and the dashboard subtitle both assert what has and hasn't
// left the machine, so they're driven from one map keyed by the real
// syncTier state instead of two hand-written strings that can drift out of
// sync with each other after the user actually picks a tier (#4285 T9).
export type SyncTierId = "full" | "metadata" | "local";

export type SyncStatusCopy = {
  dashboardSubtitle: string;
  headerStatus: string;
};

const SYNC_STATUS_COPY: Record<"none" | SyncTierId, SyncStatusCopy> = {
  none: {
    dashboardSubtitle:
      "Everything on this Mac, computed locally. No account, nothing uploaded.",
    headerStatus: "Computed on this device · 0 bytes uploaded",
  },
  full: {
    dashboardSubtitle: "Synced to your account, with full session detail.",
    headerStatus: "Synced to your account · full session detail",
  },
  metadata: {
    dashboardSubtitle:
      "Synced to your account. Session detail stays on this Mac, only counts and totals sync.",
    headerStatus: "Synced to your account · counts and totals only",
  },
  local: {
    dashboardSubtitle:
      "Signed in, nothing synced. Everything stays on this Mac.",
    headerStatus: "Signed in · nothing synced",
  },
};

export const getSyncStatusCopy = (
  syncTier: SyncTierId | null
): SyncStatusCopy => SYNC_STATUS_COPY[syncTier ?? "none"];

export type SyncDetail = { label: string; kind: "sync" | "local" };

export type SyncTier = {
  id: SyncTierId;
  title: string;
  desc: string;
  syncs: readonly SyncDetail[];
  local: readonly SyncDetail[];
  caveat?: string;
};

// Plain, parallel labels the user would actually choose between, not our
// internal "Observability" vocabulary (#4285 T11).
export const syncTiers: readonly SyncTier[] = [
  {
    id: "full",
    title: "Sync everything",
    desc: "Full session detail syncs, so you get replays, search and deep team insights on any machine.",
    syncs: [
      { label: "Everything in Sync totals only", kind: "sync" },
      { label: "Conversation turns & tools used", kind: "sync" },
      { label: "Per-turn timestamps & full replays", kind: "sync" },
    ],
    local: [],
  },
  {
    id: "metadata",
    title: "Sync totals only",
    desc: "Counts and aggregates sync to the cloud, never the contents of a session.",
    syncs: [
      { label: "Session, harness & model counts", kind: "sync" },
      { label: "Token & cost totals", kind: "sync" },
      { label: "PRs shipped", kind: "sync" },
    ],
    local: [
      { label: "Prompts & conversation turns", kind: "local" },
      { label: "Tool calls & file contents", kind: "local" },
    ],
  },
  {
    id: "local",
    title: "Keep everything on this Mac",
    desc: "Nothing leaves this machine. Your dashboard stays fully functional offline.",
    syncs: [],
    local: [{ label: "Every metric and session detail", kind: "local" }],
    caveat:
      "You won't be able to sync across machines or compare with your team.",
  },
];

// ── Guided tour ─────────────────────────────────────────────────────────
export type TourSummaryRow = {
  label: string;
  value?: string;
  chips?: readonly { text: string; ok?: boolean; muted?: boolean }[];
  sub?: string;
};

export type TourStep = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  // data-tour anchor to spotlight (omit for the intro step).
  target?: string;
  intro?: boolean;
  summary?: readonly TourSummaryRow[];
  cta?: { label: string; trigger: AuthTrigger };
};

export const tourSteps: readonly TourStep[] = [
  {
    id: "intro",
    intro: true,
    eyebrow: "Ready",
    title: "See the value of your agents' code.",
    body: "All your agent session logs have been parsed and analyzed. Keep using AI the way you already do. ClosedLoop shows you how you're using it and ways to improve.",
    summary: [
      { label: "Sessions parsed", value: "4,695", sub: "total detected" },
      {
        label: "Harnesses found",
        chips: [
          { text: "Claude Code", ok: true },
          { text: "Codex", ok: true },
          { text: "Gemini CLI", ok: false },
        ],
        sub: "Only Claude Code and Codex are validated harnesses; anything else is best-effort.",
      },
      {
        label: "Models found",
        chips: [
          { text: "claude-opus-4-7" },
          { text: "gpt-5.5" },
          { text: "claude-sonnet-4-6" },
          { text: "+8 more", muted: true },
        ],
        sub: "11 distinct models across Claude, OpenAI, and Gemini.",
      },
    ],
  },
  {
    id: "stats",
    target: "stats",
    eyebrow: "Your numbers",
    title: "The headline metrics",
    body: "Sessions analyzed, token spend, PRs shipped, and value per dollar, every figure computed locally.",
  },
  {
    id: "activity",
    target: "activity",
    eyebrow: "Activity",
    title: "When the work happens",
    body: "Each agent run and human input on this machine, plotted across the last 90 days.",
  },
  {
    id: "sessions",
    target: "sessions",
    eyebrow: "Sessions",
    title: "Every session, drillable",
    body: "A live log of each run: status, repo, model, and cost. Any row opens the full session replay.",
  },
  {
    id: "models",
    target: "models",
    eyebrow: "Models",
    title: "Breakdown by token & cost",
    body: "Spend over time by model, with a full token-and-cost breakdown by provider, so you can see where the spend goes.",
  },
  {
    id: "prs",
    target: "prs",
    eyebrow: "Pull requests",
    title: "Shipping velocity",
    body: "PRs merged over time, with a per-repository breakdown right beside it.",
  },
  {
    id: "autonomy",
    target: "autonomy",
    eyebrow: "Autonomy",
    title: "How hands-off you're getting",
    body: "The trend tracks how much your sessions run on their own versus needing your input.",
  },
  // The finale is the frosted "External AI Usage" card itself — the tour ends by
  // scrolling to it, and the always-emphasized widget carries the GitHub-first
  // CTA. No docked callout for it (avoids a redundant toast beside the widget).
];
