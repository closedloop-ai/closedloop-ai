// Presentational mock data for the Branches prototype. No DB / API / auth.
// The row + detail shapes mirror the in-product `BranchRow` (branch-row.ts) and
// `BranchPageDetail` surfaces closely enough to be a faithful foundation.

// ---------------------------------------------------------------------------
// Sidebar navigation model (duplicated from the Web UI Kit, Branches active)
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
  { label: "Sessions", icon: "sessions" },
  { label: "Branches", icon: "branches", isActive: true },
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
// Branch domain enums (const objects, mirroring the product)
// ---------------------------------------------------------------------------

export const BranchStatus = {
  Open: "open",
  Review: "review",
  Merged: "merged",
  Draft: "draft",
  Blocked: "blocked",
} as const;
export type BranchStatus = (typeof BranchStatus)[keyof typeof BranchStatus];

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

type ChipVariant =
  | "info"
  | "warning"
  | "success"
  | "muted"
  | "destructive"
  | "accent";

export const BRANCH_STATUS_CONFIG: Record<
  BranchStatus,
  { label: string; variant: ChipVariant; dot: string }
> = {
  [BranchStatus.Open]: { label: "Open", variant: "info", dot: "var(--info)" },
  [BranchStatus.Review]: {
    label: "In review",
    variant: "warning",
    dot: "var(--primary)",
  },
  [BranchStatus.Merged]: {
    label: "Merged",
    variant: "success",
    dot: "var(--success-foreground)",
  },
  [BranchStatus.Draft]: {
    label: "Draft",
    variant: "muted",
    dot: "var(--muted-foreground)",
  },
  [BranchStatus.Blocked]: {
    label: "Changes requested",
    variant: "destructive",
    dot: "var(--destructive)",
  },
};

export const PR_STATE_VARIANT: Record<PrState, ChipVariant> = {
  [PrState.Open]: "info",
  [PrState.Merged]: "success",
  [PrState.Closed]: "destructive",
};

// ---------------------------------------------------------------------------
// Branch list rows
// ---------------------------------------------------------------------------

export type BranchRow = {
  id: string;
  branchName: string;
  baseBranch: string;
  repo: string;
  /** GitHub actor who pushed the branch to the remote repository. */
  owner: string | null;
  status: BranchStatus;
  provenance: Provenance;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prState: PrState | null;
  checksPassed: number | null;
  checksTotal: number | null;
  additions: number | null;
  deletions: number | null;
  sessionCount: number;
  commentCount: number | null;
  /** Stable activity instant used for chronological sorting. */
  lastActivityAt: string;
  lastActivityLabel: string;
  /** Distinct people who commented on the pull request linked to this branch. */
  collaborators: string[];
  tags: string[];
};

export const branchRows: readonly BranchRow[] = [
  {
    id: "br_1284",
    branchName: "agent/synthetic-seed-generator",
    baseBranch: "main",
    repo: "closedloop-ai/symphony-alpha",
    owner: "Alex Rivera",
    status: BranchStatus.Review,
    provenance: Provenance.Agent,
    prNumber: 1284,
    prTitle: "Synthetic seed generator for fixtures",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1284",
    prState: PrState.Open,
    checksPassed: 9,
    checksTotal: 11,
    additions: 412,
    deletions: 38,
    sessionCount: 4,
    commentCount: 6,
    lastActivityAt: "2026-07-28T18:00:00Z",
    lastActivityLabel: "1h ago",
    collaborators: ["Alex Rivera", "Sam Chen", "Parker Byrd"],
    tags: ["fixtures", "ci", "database"],
  },
  {
    id: "br_1281",
    branchName: "agent/inbox-realtime-v2",
    baseBranch: "main",
    repo: "closedloop-ai/closedloop-web",
    owner: "Sam Chen",
    status: BranchStatus.Open,
    provenance: Provenance.Agent,
    prNumber: 1281,
    prTitle: "Inbox v2 — realtime updates",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1281",
    prState: PrState.Open,
    checksPassed: 12,
    checksTotal: 12,
    additions: 188,
    deletions: 44,
    sessionCount: 2,
    commentCount: null,
    lastActivityAt: "2026-07-28T16:00:00Z",
    lastActivityLabel: "3h ago",
    collaborators: [],
    tags: ["realtime", "frontend"],
  },
  {
    id: "br_1270",
    branchName: "agent/repo-overrides-workspace-config",
    baseBranch: "main",
    repo: "closedloop-ai/closedloop-web",
    owner: "Parker Byrd",
    status: BranchStatus.Merged,
    provenance: Provenance.Agent,
    prNumber: 1270,
    prTitle: "Migrate repositoryOverrides to workspace config",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1270",
    prState: PrState.Merged,
    checksPassed: 12,
    checksTotal: 12,
    additions: 261,
    deletions: 150,
    sessionCount: 3,
    commentCount: 4,
    lastActivityAt: "2026-07-28T17:00:00Z",
    lastActivityLabel: "2h ago",
    collaborators: ["Alex Rivera", "Parker Byrd"],
    tags: ["migration", "backend"],
  },
  {
    id: "br_saml",
    branchName: "agent/saml-sso-implementation",
    baseBranch: "main",
    repo: "closedloop-ai/symphony-alpha",
    owner: "Sam Chen",
    status: BranchStatus.Open,
    provenance: Provenance.Agent,
    prNumber: 1290,
    prTitle: "SAML SSO — implementation",
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/1290",
    prState: PrState.Open,
    checksPassed: 10,
    checksTotal: 12,
    additions: 540,
    deletions: 72,
    sessionCount: 3,
    commentCount: 2,
    lastActivityAt: "2026-07-28T13:00:00Z",
    lastActivityLabel: "6h ago",
    collaborators: ["Parker Byrd", "Sam Chen"],
    tags: ["auth", "backend"],
  },
  {
    id: "br_dark_mode",
    branchName: "agent/design-system-dark-mode",
    baseBranch: "main",
    repo: "closedloop-ai/closedloop-web",
    owner: "Jordan Lee",
    status: BranchStatus.Review,
    provenance: Provenance.Agent,
    prNumber: 1288,
    prTitle: "Implement dark mode",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1288",
    prState: PrState.Open,
    checksPassed: 12,
    checksTotal: 12,
    additions: 314,
    deletions: 58,
    sessionCount: 2,
    commentCount: null,
    lastActivityAt: "2026-07-27T15:00:00Z",
    lastActivityLabel: "yesterday",
    collaborators: [],
    tags: ["design-system", "frontend"],
  },
  {
    id: "br_1289",
    branchName: "agent/skill-registry-loader",
    baseBranch: "main",
    repo: "closedloop-ai/infra",
    owner: "Alex Rivera",
    status: BranchStatus.Blocked,
    provenance: Provenance.Agent,
    prNumber: 1289,
    prTitle: "Skill registry loader",
    prUrl: "https://github.com/closedloop-ai/infra/pull/1289",
    prState: PrState.Open,
    checksPassed: 3,
    checksTotal: 9,
    additions: 96,
    deletions: 210,
    sessionCount: 5,
    commentCount: 9,
    lastActivityAt: "2026-07-27T19:00:00Z",
    lastActivityLabel: "1d ago",
    collaborators: ["Jordan Lee", "Sam Chen"],
    tags: ["infra", "cache"],
  },
  {
    id: "br_session_cost",
    branchName: "fix/session-cost-rounding",
    baseBranch: "develop",
    repo: "closedloop-ai/closedloop-api",
    owner: "Jordan Lee",
    status: BranchStatus.Draft,
    provenance: Provenance.Human,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    additions: 24,
    deletions: 6,
    sessionCount: 1,
    commentCount: null,
    lastActivityAt: "2026-07-28T14:00:00Z",
    lastActivityLabel: "5h ago",
    collaborators: [],
    tags: ["bugfix", "billing"],
  },
  {
    id: "br_dependabot",
    branchName: "dependabot/npm_and_yarn/next-15.4.2",
    baseBranch: "main",
    repo: "closedloop-ai/closedloop-web",
    owner: null,
    status: BranchStatus.Open,
    provenance: Provenance.Bot,
    prNumber: 1292,
    prTitle: "Bump next from 15.3.4 to 15.4.2",
    prUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1292",
    prState: PrState.Open,
    checksPassed: 8,
    checksTotal: 8,
    additions: 12,
    deletions: 12,
    sessionCount: 0,
    commentCount: null,
    lastActivityAt: "2026-07-28T11:00:00Z",
    lastActivityLabel: "8h ago",
    collaborators: [],
    tags: ["dependencies", "maintenance"],
  },
];

// ---------------------------------------------------------------------------
// Summary KPI cards (mirrors BranchesSummaryCards)
// ---------------------------------------------------------------------------

export type SummaryKpi = {
  key: string;
  label: string;
  value: string;
  detail: string;
  delta?: number;
  info: { what: string; how: string };
};

export const summaryKpis: readonly SummaryKpi[] = [
  {
    key: "spend",
    label: "AI spend",
    value: "$9,061",
    detail: "estimated cost in range",
    info: {
      what: "Total estimated AI cost across your branches.",
      how: "Summed from local session token usage — no GitHub needed.",
    },
  },
  {
    key: "value-per-dollar",
    label: "Value per $",
    value: "5.98",
    detail: "lines changed per dollar",
    delta: -4,
    info: {
      what: "Total lines changed (added + removed) per dollar spent.",
      how: "Lines changed divided by estimated cost, over branches with line counts.",
    },
  },
  {
    key: "active-branches",
    label: "Active branches",
    value: "7",
    detail: "in progress",
    delta: 20,
    info: {
      what: "Branches still in progress (not merged or closed).",
      how: "Count by local branch status — no GitHub needed.",
    },
  },
  {
    key: "merge-rate",
    label: "Merge rate",
    value: "78%",
    detail: "of decided PRs",
    delta: 6,
    info: {
      what: "Share of decided PRs (merged or closed) that merged.",
      how: "Merged divided by decided over the local corpus.",
    },
  },
  {
    key: "pr-size",
    label: "Median PR size",
    value: "268",
    detail: "lines changed",
    info: {
      what: "Median lines changed per merged PR.",
      how: "Median of additions + deletions across merged PRs.",
    },
  },
];

// ---------------------------------------------------------------------------
// Branch detail fixture
// ---------------------------------------------------------------------------

export type BranchPhase = "build" | "review" | "rework";
export type WaterfallSeg =
  | { type: BranchPhase; pct: number }
  | { type: "idle"; pct: number };
export type CostSegment = {
  key: BranchPhase;
  label: string;
  duration: string;
  cost: string;
  pct: number;
  color: string;
};
export type FileChange = {
  path: string;
  additions: number;
  deletions: number;
};
export type PrComment = {
  id: string;
  /** Stable actor identifier used by fixtures and comment relationships. */
  author: string;
  at: string;
  path?: string;
  line?: number;
  /** Quoted preview of the anchored code/text, shown as a banner on the card. */
  anchorPreview?: string;
  /**
   * Trace turn this comment is anchored to, when it was created from the
   * Sessions timeline. Makes the rail's anchor preview a jump-back control.
   */
  anchorTurnId?: string;
  body: string;
};
export type SessionLane = {
  id: string;
  /** Stable trace actor identity; labels alone are not unique timeline keys. */
  actorId: string;
  actor: string;
  sub: string;
  color: string;
  isCi?: boolean;
  isResumed?: boolean;
  activeLabel: string;
  startPct: number;
  endPct: number;
  bursts: { leftPct: number; widthPct: number }[];
};
export type TimelineColumn = {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
  };
  idle?: boolean;
  segments: { color: string; pct: number }[];
};
export type EventDot = {
  leftPct: number;
  kind: "blue" | "green" | "red";
  label: string;
  at: string;
  targetTurnId: string;
};
// The Combined session trace is the agents `SessionTrace` chat transcript:
// tinted agent bubbles with rich markdown (paragraphs, bullets, inline code,
// `#NNNN` PR links), collapsible "Ran N tools" rows, right-aligned human
// bubbles, and a right gutter (time / duration / cost).
export type TraceInline = string | { code: string } | { pr: number };

export type TraceBlock =
  | { type: "p"; spans: TraceInline[] }
  | { type: "ul"; items: TraceInline[][] }
  | {
      type: "tools";
      summary: string;
      rows: { label: string; detail?: string }[];
    };

export type TraceUser = {
  id: string;
  name: string;
  initials: string;
};

// The human users who can appear in a branch's trace. A branch that involves
// multiple users color-coordinates the transcript per user (hue is assigned by
// deterministic actor order in the branch — see buildActorColorMap in the trace
// renderer — so the same actor keeps the same chart color across surfaces.
export const TRACE_USERS: Record<string, TraceUser> = {
  "u-alex": { id: "u-alex", name: "Alex Rivera", initials: "AR" },
  "u-sam": { id: "u-sam", name: "Sam Chen", initials: "SC" },
  "u-jordan": { id: "u-jordan", name: "Jordan Lee", initials: "JL" },
  "u-parker": { id: "u-parker", name: "Parker Byrd", initials: "PB" },
};

const COMMENT_AUTHOR_NAMES: Record<string, string> = {
  "alex-rivera": "Alex Rivera",
  "jordan-lee": "Jordan Lee",
  "parker-byrd": "Parker Byrd",
  "sam-chen": "Sam Chen",
};

/** Resolve a stable comment author ID to the name shown in the prototype. */
export function commentAuthorName(authorId: string): string {
  return COMMENT_AUTHOR_NAMES[authorId] ?? authorId;
}

export type TraceTurn = {
  id: string;
  /** Which human user's session this turn belongs to (drives the per-user hue). */
  userId: string;
  side: "human" | "agent";
  timeLabel: string;
  durationLabel?: string;
  costLabel?: string;
  model?: string;
  blocks: TraceBlock[];
};

export type BranchDetail = {
  id: string;
  branchName: string;
  repoFullName: string;
  status: BranchStatus;
  provenance: Provenance;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  prState: PrState | null;
  prBody: string | null;
  additions: number | null;
  deletions: number | null;
  costLabel: string;
  valuePerDollar: string;
  leadTimeLabel: string;
  /** Total wall-clock span of the branch's sessions — always a duration. */
  wallClockLabel: string;
  activeLabel: string;
  idleLabel: string;
  idlePct: number;
  merged: boolean;
  waterfall: WaterfallSeg[];
  costTotal: string;
  costSegments: CostSegment[];
  deliveredArtifacts: { slug: string }[];
  reviewLabel: string;
  checks: { passed: number; total: number } | null;
  files: FileChange[];
  filesSource: "github" | "local";
  comments: PrComment[];
  sessionComments: PrComment[];
  sessions: SessionLane[];
  timeline: {
    legend: { actorId: string; name: string; color: string }[];
    columns: TimelineColumn[];
    startLabel: string;
    endLabel: string;
  };
  eventDots: EventDot[];
  githubConnected: boolean;
  trace: TraceTurn[];
  multiPrWarning: boolean;
  linkedPrNumbers: number[];
};

const REPO_SHORT = (repo: string) => repo.split("/").at(-1) ?? repo;

export function shortRepoName(repo: string): string {
  return REPO_SHORT(repo);
}
