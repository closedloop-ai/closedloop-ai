// Presentational mock data for the Sessions prototype. No DB / API / auth.
// The row + detail shapes mirror the in-product `AgentSessionListItem` /
// `SessionTableRow` (packages/app/agents/components/sessions/sessions-table.tsx)
// and `AgentSessionDetail` surfaces closely enough to be a faithful foundation.

// ---------------------------------------------------------------------------
// Sidebar navigation model (duplicated from the Web UI Kit, Sessions active)
// ---------------------------------------------------------------------------

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export type NavIconName =
  | "dashboard"
  | "inbox"
  | "my-issues"
  | "documents"
  | "issues"
  | "sessions"
  | "branches"
  | "agents"
  | "insights"
  | "loops"
  | "agent-monitoring"
  | "judges";

export type TeamFavorite = { id: string; name: string };

export type TeamItem = {
  id: string;
  name: string;
  isActive?: boolean;
  favorites?: readonly TeamFavorite[];
};

export const primaryNav: readonly NavItem[] = [
  { label: "Dashboard", icon: "dashboard" },
  { label: "Inbox", icon: "inbox", count: 8 },
  { label: "My Issues", icon: "my-issues" },
];

export const artifactsNav: readonly NavItem[] = [
  { label: "Documents", icon: "documents" },
  { label: "Issues", icon: "issues" },
  { label: "Sessions", icon: "sessions", isActive: true },
  { label: "Branches", icon: "branches" },
  { label: "Agents", icon: "agents" },
];

export const teams: readonly TeamItem[] = [
  { id: "team-demo", name: "ClosedLoop Demo" },
  {
    id: "team-closedloop",
    name: "ClosedLoop",
    favorites: [
      { id: "fav-night-crew", name: "Night Crew" },
      { id: "fav-parker-triage", name: "Parker Triage" },
      { id: "fav-sprint", name: "6/29-7/2" },
    ],
  },
  { id: "team-platform", name: "Platform Engineering" },
  { id: "team-pe-test", name: "PE TEST" },
];

export const labsNav: readonly NavItem[] = [
  { label: "Insights", icon: "insights" },
  { label: "Loops", icon: "loops" },
  { label: "Agent Monitoring", icon: "agent-monitoring" },
  { label: "Judges", icon: "judges" },
];

// ---------------------------------------------------------------------------
// Session domain enums (const objects, mirroring the product)
// ---------------------------------------------------------------------------

// Mirrors SESSION_STATUS in @repo/api/src/types/session-status ("error" is the wire
// value the UI labels as "Failed").
export const SessionStatus = {
  Active: "active",
  Completed: "completed",
  Failed: "error",
  Abandoned: "abandoned",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const Harness = {
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor",
  Copilot: "copilot",
  OpenCode: "opencode",
} as const;
export type Harness = (typeof Harness)[keyof typeof Harness];

export const Provenance = {
  Human: "human",
  Agent: "agent",
  Bot: "bot",
} as const;
export type Provenance = (typeof Provenance)[keyof typeof Provenance];

export const PrState = {
  Open: "open",
  Merged: "merged",
  Closed: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export const DATE_RANGES = ["7d", "30d", "90d", "all"] as const;
export type DateRange = (typeof DATE_RANGES)[number];

// Time window (in minutes) each range keeps. A session is in-range when it
// started no longer ago than this. This is what makes the date toggle a real
// first-class filter (mirrors the in-product DateRangeFilter driving the query).
export const WINDOW_MINUTES: Record<DateRange, number> = {
  "7d": 7 * 24 * 60,
  "30d": 30 * 24 * 60,
  "90d": 90 * 24 * 60,
  all: Number.POSITIVE_INFINITY,
};

type ChipVariant =
  | "info"
  | "warning"
  | "success"
  | "muted"
  | "destructive"
  | "accent";

export const SESSION_STATUS_CONFIG: Record<
  SessionStatus,
  { label: string; variant: ChipVariant; dot: string; pulse?: boolean }
> = {
  [SessionStatus.Active]: {
    label: "Active",
    variant: "info",
    dot: "var(--info)",
    pulse: true,
  },
  [SessionStatus.Completed]: {
    label: "Completed",
    variant: "success",
    dot: "var(--success-foreground)",
  },
  [SessionStatus.Failed]: {
    label: "Failed",
    variant: "destructive",
    dot: "var(--destructive)",
  },
  [SessionStatus.Abandoned]: {
    label: "Abandoned",
    variant: "muted",
    dot: "var(--muted-foreground)",
  },
};

export const HARNESS_CONFIG: Record<Harness, { label: string }> = {
  [Harness.Claude]: { label: "Claude" },
  [Harness.Codex]: { label: "Codex" },
  [Harness.Cursor]: { label: "Cursor" },
  [Harness.Copilot]: { label: "Copilot" },
  [Harness.OpenCode]: { label: "OpenCode" },
};

export const PR_STATE_VARIANT: Record<PrState, ChipVariant> = {
  [PrState.Open]: "info",
  [PrState.Merged]: "success",
  [PrState.Closed]: "destructive",
};

// Autonomy is presented as a Low / Medium / High chip (PRD-557 FEA-4206); the
// raw 0-100 score is kept on the row and surfaced on the Session Detail page.
// Thresholds mirror the in-product `autonomyTiers` facet.
export const AutonomyTier = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type AutonomyTier = (typeof AutonomyTier)[keyof typeof AutonomyTier];

export const AUTONOMY_TIER_CONFIG: Record<
  AutonomyTier,
  { label: string; variant: ChipVariant }
> = {
  [AutonomyTier.High]: { label: "High", variant: "success" },
  [AutonomyTier.Medium]: { label: "Medium", variant: "info" },
  [AutonomyTier.Low]: { label: "Low", variant: "muted" },
};

export function autonomyTier(score: number): AutonomyTier {
  if (score >= 67) {
    return AutonomyTier.High;
  }
  if (score >= 34) {
    return AutonomyTier.Medium;
  }
  return AutonomyTier.Low;
}

// Model is a neutral outline chip carrying a small provider-colored dot (PRD-557
// FEA-4221): the dot separates Anthropic / OpenAI / Google at a glance without a
// second fully-tinted chip competing with Status's traffic-light palette. The
// dot color is a design token, never a hardcoded brand hex.
export const ModelProvider = {
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  Other: "other",
} as const;
export type ModelProvider = (typeof ModelProvider)[keyof typeof ModelProvider];

export const MODEL_PROVIDER_CONFIG: Record<
  ModelProvider,
  { label: string; dotClass: string }
> = {
  [ModelProvider.Anthropic]: { label: "Anthropic", dotClass: "text-primary" },
  [ModelProvider.OpenAI]: { label: "OpenAI", dotClass: "text-success" },
  [ModelProvider.Google]: { label: "Google", dotClass: "text-info" },
  [ModelProvider.Other]: { label: "Model", dotClass: "text-muted-foreground" },
};

export function modelProvider(model: string): ModelProvider {
  if (model.startsWith("claude")) {
    return ModelProvider.Anthropic;
  }
  if (
    model.startsWith("gpt") ||
    model.startsWith("o1") ||
    model.startsWith("o3")
  ) {
    return ModelProvider.OpenAI;
  }
  if (model.startsWith("gemini")) {
    return ModelProvider.Google;
  }
  return ModelProvider.Other;
}

// Session tags (PRD-557 FEA-4213). Tags render as one quiet muted chip: Status
// owns the semantic red/green/amber palette, so categories stay neutral and a
// red "auth" tag never reads as a failure signal.
export type SessionTag = { label: string };

// A linked issue chip (PRD-557 FEA-4210) — slug plus an optional deep link.
export type LinkedIssue = { slug: string; title: string; url: string };

// A linked agent chip (PRD-557 FEA-4212) — the agent/component that ran or was
// invoked in the session.
export type LinkedAgent = { name: string };

// One entry in the group-by control (PRD-557 FEA-4200). "None" is the flat list.
export const GroupBy = {
  None: "none",
  Status: "status",
  Harness: "harness",
  Owner: "owner",
} as const;
export type GroupBy = (typeof GroupBy)[keyof typeof GroupBy];

// ---------------------------------------------------------------------------
// Session list rows
//
// Timestamps and durations are stored as NUMBERS (minutes-ago / milliseconds)
// so filtering and sorting operate on real values; the display labels are
// derived from those numbers by `formatAgo` / `formatDuration` so the label and
// the sort key can never drift (the in-product query builder warns that sorting
// the formatted wall-clock string sorts lexicographically and is wrong).
// ---------------------------------------------------------------------------

export type SessionUser = { name: string; initials: string };

export type SessionRow = {
  id: string;
  name: string;
  externalSessionId: string;
  user: SessionUser | null;
  status: SessionStatus;
  harness: Harness;
  provenance: Provenance;
  model: string | null;
  /** Autonomy score 0-100 (FEA-2094); null when no metric is available. */
  autonomy: number | null;
  repo: string | null;
  branch: string | null;
  /** Additional linked branches beyond the primary `branch` (PRD-557 FEA-4211);
   *  surfaced as a "+N" overflow count so the cell stays one line. */
  extraBranches?: readonly string[];
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prState: PrState | null;
  mergeStatusLabel: string | null;
  /** Wall-clock duration in ms — the sort key; the label is derived. */
  durationMs: number;
  /** Minutes since the session started — drives the date-window filter + sort. */
  startedAgoMinutes: number;
  /** Minutes since the last genuine activity — the default sort key. */
  lastActivityAgoMinutes: number;
  /** Estimated cost in dollars (cost cell, KPI aggregate, timeline scaling). */
  cost: number;
  /** Estimated token usage split into input and output for KPI aggregation. */
  inputTokens: number;
  outputTokens: number;
  /** Equivalent usage-based API cost before subscription savings. */
  apiEquivalentCost: number;
  /** Lines added/removed on the session's PR; null when there is no PR. */
  additions: number | null;
  deletions: number | null;
  workingDir: string;
  /** Minutes since the last Claude Code activity update (FEA-4214 "Updated"). */
  updatedAgoMinutes: number;
  /** ClosedLoop comment count on the session (FEA-4204). */
  commentCount: number;
  /** Per-user starred state (FEA-4205); the prototype seeds a few favorites. */
  isFavorite: boolean;
  /** True when the session is blocked on a human review/decision (FEA-4219). */
  needsYou: boolean;
  /** Additional participants beyond the owner (FEA-4208). */
  collaborators: readonly SessionUser[];
  /** Projects the session contributes to (FEA-4209). */
  projects: readonly string[];
  /** Linked issues (FEA-4210). */
  linkedIssues: readonly LinkedIssue[];
  /** Linked agents / components (FEA-4212). */
  linkedAgents: readonly LinkedAgent[];
  /** Session tags (FEA-4213). */
  tags: readonly SessionTag[];
};

const allSessionRows: readonly SessionRow[] = [
  {
    id: "ses_9f31",
    name: "closedloop-electron",
    externalSessionId: "019f8b4c-8aad-753e-9a31-63df72b91271",
    user: { name: "Kris Wong", initials: "KW" },
    status: SessionStatus.Completed,
    harness: Harness.Claude,
    provenance: Provenance.Agent,
    model: "claude-opus-4-8",
    autonomy: 84,
    repo: "closedloop-ai/symphony-alpha",
    branch: "fix/desktop-session-transcript",
    extraBranches: [],
    prNumber: 1284,
    prTitle: "Synthetic seed generator for fixtures",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1284",
    prState: PrState.Open,
    mergeStatusLabel: "Draft",
    durationMs: (2 * 60 + 17) * 60_000,
    startedAgoMinutes: 42,
    lastActivityAgoMinutes: 0,
    cost: 12.48,
    inputTokens: 840_000,
    outputTokens: 112_000,
    apiEquivalentCost: 21.35,
    additions: 412,
    deletions: 38,
    workingDir: "~/code/symphony-alpha",
    updatedAgoMinutes: 0,
    commentCount: 3,
    isFavorite: true,
    needsYou: false,
    collaborators: [
      { name: "Parker Byrd", initials: "PB" },
      { name: "Sam Chen", initials: "SC" },
    ],
    projects: ["7/21-25", "Fixtures"],
    linkedIssues: [
      {
        slug: "FEA-4199",
        title: "Rows-per-page control",
        url: "https://app.closedloop.ai/closedloop-ai/features/FEA-4199",
      },
    ],
    linkedAgents: [{ name: "test-engineer" }, { name: "design-engineer" }],
    tags: [{ label: "fixtures" }, { label: "P1" }],
  },
  {
    id: "ses_8c7a",
    name: "Inbox v2 realtime updates",
    externalSessionId: "8c7a1de0-4432-49ab-9c21-77aa11bb22cc",
    user: { name: "Sam Chen", initials: "SC" },
    status: SessionStatus.Completed,
    harness: Harness.Codex,
    provenance: Provenance.Agent,
    model: "gpt-5-codex",
    autonomy: 71,
    repo: "closedloop-ai/closedloop-web",
    branch: "agent/inbox-realtime-v2",
    prNumber: 1281,
    prTitle: "Inbox v2 — realtime updates",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1281",
    prState: PrState.Open,
    mergeStatusLabel: "Checks passing",
    durationMs: 5000,
    startedAgoMinutes: 198,
    lastActivityAgoMinutes: 120,
    cost: 21.9,
    inputTokens: 1_420_000,
    outputTokens: 186_000,
    apiEquivalentCost: 38.44,
    additions: 188,
    deletions: 44,
    workingDir: "~/code/closedloop-web",
    updatedAgoMinutes: 110,
    commentCount: 7,
    isFavorite: false,
    needsYou: true,
    collaborators: [{ name: "Jordan Lee", initials: "JL" }],
    projects: ["Inbox v2"],
    linkedIssues: [
      {
        slug: "FEA-4203",
        title: "Live/running affordances",
        url: "https://app.closedloop.ai/closedloop-ai/features/FEA-4203",
      },
      {
        slug: "FEA-4204",
        title: "Comment counts",
        url: "https://app.closedloop.ai/closedloop-ai/features/FEA-4204",
      },
    ],
    linkedAgents: [{ name: "realtime-architect" }],
    tags: [{ label: "realtime" }],
  },
  {
    id: "ses_7b02",
    name: "Investigate cloud delay in ClosedLoop session turns",
    externalSessionId: "019fa447-1ab9-742b-8c43-abbeed1a51a8",
    user: { name: "Kris Wong", initials: "KW" },
    status: SessionStatus.Completed,
    harness: Harness.Claude,
    provenance: Provenance.Agent,
    model: "claude-sonnet-5",
    autonomy: 92,
    repo: "closedloop-ai/symphony-alpha",
    branch: "fix/desktop-transcript-live-flush-all-harnesses",
    prNumber: 1270,
    prTitle: "Flush live desktop transcript updates for all harnesses",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1270",
    prState: PrState.Merged,
    mergeStatusLabel: "Merged",
    durationMs: (5 * 60 + 34) * 60_000,
    startedAgoMinutes: 1590,
    lastActivityAgoMinutes: 1500,
    cost: 33.15,
    inputTokens: 2_180_000,
    outputTokens: 294_000,
    apiEquivalentCost: 58.72,
    additions: 1360,
    deletions: 285,
    workingDir: "~/code/symphony-alpha",
    updatedAgoMinutes: 1500,
    commentCount: 2,
    isFavorite: true,
    needsYou: false,
    collaborators: [],
    projects: ["Workspace config"],
    linkedIssues: [
      {
        slug: "FEA-4021",
        title: "Column reorder",
        url: "https://app.closedloop.ai/closedloop-ai/features/FEA-4021",
      },
    ],
    linkedAgents: [{ name: "database-architect" }],
    tags: [{ label: "migration" }, { label: "config" }],
  },
  {
    id: "ses_6d55",
    name: "Source",
    externalSessionId: "019f8bc3-3515-7598-a10f-37b9da5f4747",
    user: { name: "Daniel Ochoa", initials: "DO" },
    status: SessionStatus.Completed,
    harness: Harness.Codex,
    provenance: Provenance.Agent,
    model: "gpt-5.5",
    autonomy: 63,
    repo: null,
    branch: null,
    extraBranches: [],
    prNumber: 1290,
    prTitle: "SAML SSO — implementation",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1290",
    prState: PrState.Open,
    mergeStatusLabel: "2 failing",
    durationMs: (22 * 60 + 17) * 60_000,
    startedAgoMinutes: 18 * 60 + 56,
    lastActivityAgoMinutes: 8,
    cost: 508.75,
    inputTokens: 1_190_000,
    outputTokens: 168_000,
    apiEquivalentCost: 34.16,
    additions: 540,
    deletions: 72,
    workingDir: "~/code/symphony-alpha",
    updatedAgoMinutes: 6,
    commentCount: 5,
    isFavorite: false,
    needsYou: true,
    collaborators: [
      { name: "Alex Rivera", initials: "AR" },
      { name: "Sam Chen", initials: "SC" },
      { name: "Jordan Lee", initials: "JL" },
    ],
    projects: ["Enterprise", "SSO"],
    linkedIssues: [
      {
        slug: "FEA-3560",
        title: "URL-addressable facets",
        url: "https://app.closedloop.ai/closedloop-ai/features/FEA-3560",
      },
    ],
    linkedAgents: [{ name: "auth-security-expert" }],
    tags: [{ label: "auth" }, { label: "enterprise" }],
  },
  {
    id: "ses_5e18",
    name: "Analyze session activity attribution against golden dataset",
    externalSessionId: "019f95de-63c7-73a0-b2b5-f8815460d21b",
    user: { name: "Kris Wong", initials: "KW" },
    status: SessionStatus.Completed,
    harness: Harness.Claude,
    provenance: Provenance.Agent,
    model: "claude-fable-5",
    autonomy: 88,
    repo: "closedloop-ai/symphony-alpha",
    branch: "fix/aa03-declared-signal-categories",
    prNumber: 1288,
    prTitle: "Declare session activity signal categories",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1288",
    prState: PrState.Merged,
    mergeStatusLabel: "Merged",
    durationMs: (73 * 60 + 47) * 60_000,
    startedAgoMinutes: 12 * 24 * 60 + 40,
    lastActivityAgoMinutes: 12 * 24 * 60,
    cost: 270.77,
    inputTokens: 1_860_000,
    outputTokens: 224_000,
    apiEquivalentCost: 49.83,
    additions: 13_925,
    deletions: 234,
    workingDir: "~/code/symphony-alpha",
    updatedAgoMinutes: 12 * 24 * 60,
    commentCount: 0,
    isFavorite: false,
    needsYou: false,
    collaborators: [{ name: "Sam Chen", initials: "SC" }],
    projects: ["Design system"],
    linkedIssues: [],
    linkedAgents: [
      { name: "design-system-steward" },
      { name: "visual-qa-critic" },
    ],
    tags: [{ label: "design-system" }],
  },
  {
    id: "ses_4a90",
    name: "Skill registry loader",
    externalSessionId: "4a90c8f2-6b33-4e51-9d0a-77bb88cc99dd",
    user: { name: "Alex Rivera", initials: "AR" },
    status: SessionStatus.Failed,
    harness: Harness.OpenCode,
    provenance: Provenance.Agent,
    model: "claude-opus-4-8",
    autonomy: 41,
    repo: "closedloop-ai/infra",
    branch: "agent/skill-registry-loader",
    prNumber: 1289,
    prTitle: "Skill registry loader",
    prUrl: "https://github.com/closedloop-ai/infra/pull/1289",
    prState: PrState.Open,
    mergeStatusLabel: "6 failing",
    durationMs: 0,
    startedAgoMinutes: 40 * 24 * 60,
    lastActivityAgoMinutes: 40 * 24 * 60 - 34,
    cost: 9.06,
    inputTokens: 620_000,
    outputTokens: 91_000,
    apiEquivalentCost: 16.8,
    additions: 96,
    deletions: 210,
    workingDir: "~/code/infra",
    updatedAgoMinutes: 40 * 24 * 60 - 34,
    commentCount: 4,
    isFavorite: false,
    needsYou: false,
    collaborators: [],
    projects: ["Skills"],
    linkedIssues: [],
    linkedAgents: [{ name: "devops-architect" }],
    tags: [{ label: "infra" }],
  },
  {
    id: "ses_3f27",
    name: "Fix session cost rounding",
    externalSessionId: "3f2711ab-55cd-4e90-8a12-0011223344ff",
    user: { name: "Jordan Lee", initials: "JL" },
    status: SessionStatus.Abandoned,
    harness: Harness.Claude,
    provenance: Provenance.Human,
    model: "claude-sonnet-5",
    autonomy: null,
    repo: "closedloop-ai/closedloop-api",
    branch: "fix/session-cost-rounding",
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    mergeStatusLabel: null,
    durationMs: 9 * 60_000 + 27_000,
    startedAgoMinutes: 8 * 24 * 60,
    lastActivityAgoMinutes: 8 * 24 * 60 - 11,
    cost: 1.34,
    inputTokens: 94_000,
    outputTokens: 18_000,
    apiEquivalentCost: 2.41,
    additions: null,
    deletions: null,
    workingDir: "~/code/closedloop-api",
    updatedAgoMinutes: 8 * 24 * 60 - 11,
    commentCount: 1,
    isFavorite: false,
    needsYou: false,
    collaborators: [],
    projects: [],
    linkedIssues: [],
    linkedAgents: [],
    tags: [],
  },
  {
    id: "ses_2b64",
    name: "Bump next from 15.3.4 to 15.4.2",
    externalSessionId: "2b64d9e0-3311-4c88-b7f2-99aa88bb77cc",
    user: null,
    status: SessionStatus.Completed,
    harness: Harness.Copilot,
    provenance: Provenance.Bot,
    model: "gpt-5-mini",
    autonomy: 22,
    repo: "closedloop-ai/closedloop-web",
    branch: "dependabot/npm_and_yarn/next-15.4.2",
    prNumber: 1292,
    prTitle: "Bump next from 15.3.4 to 15.4.2",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1292",
    prState: PrState.Open,
    mergeStatusLabel: "Checks passing",
    durationMs: 0,
    startedAgoMinutes: 200,
    lastActivityAgoMinutes: 180,
    cost: 0.28,
    inputTokens: 22_000,
    outputTokens: 4000,
    apiEquivalentCost: 0.52,
    additions: 12,
    deletions: 12,
    workingDir: "~/code/closedloop-web",
    updatedAgoMinutes: 180,
    commentCount: 0,
    isFavorite: false,
    needsYou: false,
    collaborators: [],
    projects: ["Dependencies"],
    linkedIssues: [],
    linkedAgents: [],
    tags: [{ label: "dependabot" }],
  },
];

const PRODUCTION_EXAMPLE_IDS = new Set([
  "ses_9f31",
  "ses_7b02",
  "ses_6d55",
  "ses_5e18",
]);

/** Four production-derived fixtures spanning each supported default scale. */
export const sessionRows: readonly SessionRow[] = allSessionRows.filter((row) =>
  PRODUCTION_EXAMPLE_IDS.has(row.id)
);

// ---------------------------------------------------------------------------
// Display formatters — labels are derived from the numeric sort keys so the two
// can never drift (review: sorting on the formatted string sorts wrong).
// ---------------------------------------------------------------------------

export function formatAgo(minutes: number): string {
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${Math.round(minutes)}m ago`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${Math.round(hours)}h ago`;
  }
  const days = hours / 24;
  if (days < 2) {
    return "yesterday";
  }
  return `${Math.round(days)}d ago`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

const REPO_SHORT = (repo: string) => repo.split("/").at(-1) ?? repo;

export function shortRepoName(repo: string): string {
  return REPO_SHORT(repo);
}
