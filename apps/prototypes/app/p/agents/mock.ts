// Agents page — mock data.
//
// Ported from the Claude Design "app" UI kit (ui_kits/app/AgentsSummary.jsx +
// AgentsData.jsx): an inventory of harness extensions (skills, subagents, MCP
// tools, commands, workflows, hooks, and memory/config files) scored by usage
// and merged-LOC-per-dollar. Presentational, mock-only.

// ---------------------------------------------------------------------------
// Sidebar navigation model (mirrors the shared app shell)
// ---------------------------------------------------------------------------

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

export type NavItem = {
  label: string;
  icon: NavIconName;
  count?: number;
  isActive?: boolean;
};

export type TeamFavorite = {
  id: string;
  name: string;
};

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
  { label: "Branches", icon: "branches" },
  { label: "Agents", icon: "agents", isActive: true },
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
// Component inventory model
// ---------------------------------------------------------------------------

export const AgentComponentKind = {
  Subagent: "subagent",
  Command: "command",
  Skill: "skill",
  Workflow: "workflow",
  Mcp: "mcp",
  Hook: "hook",
  Config: "config",
} as const;

export type AgentComponentKind =
  (typeof AgentComponentKind)[keyof typeof AgentComponentKind];

export const Harness = {
  Claude: "claude",
  Codex: "codex",
  Both: "both",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

// Where a component came from. `pack` = installed from a marketplace; `repo` =
// checked into a source repository; `local` = builder-specific; `server` = the
// MCP server that exposes the tool; `scope` = the cascade level of a config file.
export const SourceType = {
  Pack: "pack",
  Repo: "repo",
  Local: "local",
  Server: "server",
  Scope: "scope",
} as const;

export type SourceType = (typeof SourceType)[keyof typeof SourceType];

export type AgentComponent = {
  id: string;
  name: string;
  kind: AgentComponentKind;
  sourceType: SourceType;
  /** Display label for the Source column (pack name, repo, server, or scope). */
  source: string;
  harness: Harness;
  /** Usage metrics — null for configured-only kinds with no reliable logs. */
  invocations: number | null;
  sessions: number | null;
  locPerDollar: number | null;
  trend: readonly number[];
};

// Only these kinds carry real usage data observed in the session logs. Hooks
// and memory/config files are configured-only and render usage as "—".
const OBSERVED_KINDS = new Set<AgentComponentKind>([
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Workflow,
  AgentComponentKind.Mcp,
]);

export const isObservedKind = (kind: AgentComponentKind): boolean =>
  OBSERVED_KINDS.has(kind);

// The team-member pool. Per PRD-519 a component has a *source*, not an owner —
// ownership lives on usage rows (sessions and branches), which have real owners.
// These names populate those usage-row owners (see detail-data.ts) and the
// usage-derived Collaborators stack below.
export const OWNER_NAMES: readonly string[] = [
  "Maya Chen",
  "Devon Park",
  "Sasha Ortiz",
  "Imani Reid",
  "Kenji Tan",
  "Ada Nunez",
];

const COLLAB_HASH_MODULUS = 1_000_003;
const collabHash = (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % COLLAB_HASH_MODULUS;
  }
  return hash;
};

// Usage-derived contributors: the set of team members who have *used* a
// component (rendered as the Collaborators avatar stack). Per PRD-519 this is
// usage-derived, not authorship — a component has a source, not an owner.
// Deterministic window over the team pool so the mock stays stable.
export const collaboratorsFor = (
  component: AgentComponent
): readonly string[] => {
  const start = collabHash(component.id) % OWNER_NAMES.length;
  const count = 2 + (collabHash(`${component.id}:collab`) % 4);
  return Array.from(
    { length: count },
    (_, index) => OWNER_NAMES[(start + index) % OWNER_NAMES.length]
  );
};

// A handful of components flagged as recently added, so the redesign can
// exercise the "what's new" surfacing the review asked for. Deterministic set,
// no dates.
export const NEW_COMPONENT_IDS: ReadonlySet<string> = new Set([
  "skill:prototype",
  "command:/bootstrap:start",
  "subagent:playwright-helper",
]);

export const isNewComponent = (component: AgentComponent): boolean =>
  NEW_COMPONENT_IDS.has(component.id);

// A component "produced code" when its usage carries merged-code attribution
// (an observed kind with a value metric). Configured-only kinds never did. Used
// by the redesign's "produced code" filter to isolate coding sessions.
export const hasProducedCode = (component: AgentComponent): boolean =>
  component.locPerDollar !== null;

export const mockComponents: readonly AgentComponent[] = [
  // Agents (subagent definitions)
  {
    id: "subagent:ai-agent-orchestration-expert",
    name: "ai-agent-orchestration-expert",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "symphony-alpha",
    harness: Harness.Claude,
    invocations: 1306,
    sessions: 81,
    locPerDollar: 8100,
    trend: [5, 6, 6, 7, 7, 8, 8, 8],
  },
  {
    id: "subagent:visual-qa-agent",
    name: "visual-qa-agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "astoria-frontend",
    harness: Harness.Claude,
    invocations: 902,
    sessions: 31,
    locPerDollar: 7700,
    trend: [5, 6, 6, 6, 7, 7, 7, 8],
  },
  {
    id: "subagent:902_ai_python_developer",
    name: "902_ai_python_developer",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Local,
    source: "Local",
    harness: Harness.Claude,
    invocations: 233,
    sessions: 40,
    locPerDollar: 5600,
    trend: [4, 5, 5, 5, 5, 6, 6, 6],
  },
  {
    id: "subagent:bmad-orchestrator",
    name: "bmad-orchestrator",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "BMAD-METHOD",
    harness: Harness.Both,
    invocations: 388,
    sessions: 22,
    locPerDollar: 6400,
    trend: [5, 5, 6, 6, 6, 6, 6, 6],
  },
  {
    id: "subagent:playwright-helper",
    name: "playwright-helper",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Claude,
    invocations: 740,
    sessions: 64,
    locPerDollar: 6800,
    trend: [6, 6, 7, 7, 7, 7, 7, 8],
  },
  {
    id: "subagent:visual-qa-subagent",
    name: "visual-qa-subagent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Codex,
    invocations: 312,
    sessions: 41,
    locPerDollar: 6200,
    trend: [4, 5, 5, 5, 6, 6, 6, 6],
  },
  // Commands (slash commands)
  {
    id: "command:/deploy",
    name: "/deploy",
    kind: AgentComponentKind.Command,
    sourceType: SourceType.Local,
    source: "Local",
    harness: Harness.Claude,
    invocations: 38,
    sessions: 9,
    locPerDollar: 5200,
    trend: [4, 4, 5, 5, 5, 5, 5, 5],
  },
  {
    id: "command:/code-review",
    name: "/code-review",
    kind: AgentComponentKind.Command,
    sourceType: SourceType.Pack,
    source: "code-review",
    harness: Harness.Both,
    invocations: 624,
    sessions: 240,
    locPerDollar: 7900,
    trend: [6, 6, 7, 7, 7, 8, 8, 8],
  },
  {
    id: "command:/gh-daily-summary",
    name: "/gh-daily-summary",
    kind: AgentComponentKind.Command,
    sourceType: SourceType.Repo,
    source: "astoria-frontend",
    harness: Harness.Both,
    invocations: 198,
    sessions: 96,
    locPerDollar: 6100,
    trend: [5, 5, 6, 6, 6, 6, 6, 6],
  },
  {
    id: "command:/update-documentation",
    name: "/update-documentation",
    kind: AgentComponentKind.Command,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Claude,
    invocations: 156,
    sessions: 72,
    locPerDollar: 5400,
    trend: [4, 5, 5, 5, 5, 5, 5, 5],
  },
  {
    id: "command:/bootstrap:start",
    name: "/bootstrap:start",
    kind: AgentComponentKind.Command,
    sourceType: SourceType.Pack,
    source: "bootstrap",
    harness: Harness.Both,
    invocations: 503,
    sessions: 201,
    locPerDollar: 8000,
    trend: [6, 7, 7, 7, 8, 8, 8, 8],
  },
  // Skills (SKILL.md)
  {
    id: "skill:add-converter",
    name: "add-converter",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "acplugin",
    harness: Harness.Claude,
    invocations: 88,
    sessions: 33,
    locPerDollar: 4300,
    trend: [5, 5, 4, 4, 4, 4, 4, 4],
  },
  {
    id: "skill:pytest-runner",
    name: "pytest-runner",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "astoria-service",
    harness: Harness.Both,
    invocations: 466,
    sessions: 121,
    locPerDollar: 6000,
    trend: [5, 5, 6, 6, 6, 6, 6, 6],
  },
  {
    id: "skill:figma-analytics-extractor",
    name: "figma-analytics-extractor",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "claude_code",
    harness: Harness.Claude,
    invocations: 276,
    sessions: 110,
    locPerDollar: 6200,
    trend: [4, 5, 5, 5, 6, 6, 6, 6],
  },
  {
    id: "skill:decision-table",
    name: "decision-table",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Both,
    invocations: 410,
    sessions: 150,
    locPerDollar: 6600,
    trend: [5, 5, 6, 6, 6, 7, 7, 7],
  },
  {
    id: "skill:prototype",
    name: "prototype",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "symphony-alpha",
    harness: Harness.Claude,
    invocations: 642,
    sessions: 196,
    locPerDollar: 9200,
    trend: [6, 7, 7, 8, 8, 9, 9, 9],
  },
  {
    id: "skill:vercel-react-best-practices",
    name: "vercel-react-best-practices",
    kind: AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "symphony-alpha",
    harness: Harness.Codex,
    invocations: 188,
    sessions: 72,
    locPerDollar: 6000,
    trend: [4, 5, 5, 5, 5, 6, 6, 6],
  },
  // MCP tools (mcp__<server>__<tool>) — Source is the server
  {
    id: "mcp:github/get_pull_request",
    name: "get_pull_request",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "github",
    harness: Harness.Claude,
    invocations: 1240,
    sessions: 540,
    locPerDollar: 6800,
    trend: [5, 6, 6, 6, 7, 7, 7, 7],
  },
  {
    id: "mcp:github/create_pull_request",
    name: "create_pull_request",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "github",
    harness: Harness.Claude,
    invocations: 690,
    sessions: 410,
    locPerDollar: 6900,
    trend: [5, 5, 6, 6, 6, 7, 7, 7],
  },
  {
    id: "mcp:github/search_code",
    name: "search_code",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "github",
    harness: Harness.Claude,
    invocations: 412,
    sessions: 230,
    locPerDollar: 6400,
    trend: [5, 5, 6, 6, 6, 6, 6, 6],
  },
  {
    id: "mcp:closedloop/get-me",
    name: "get-me",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "closedloop",
    harness: Harness.Codex,
    invocations: 880,
    sessions: 360,
    locPerDollar: 6500,
    trend: [5, 5, 6, 6, 6, 7, 7, 7],
  },
  {
    id: "mcp:closedloop/list-loops",
    name: "list-loops",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "closedloop",
    harness: Harness.Codex,
    invocations: 540,
    sessions: 230,
    locPerDollar: 6100,
    trend: [5, 5, 6, 6, 6, 6, 6, 6],
  },
  {
    id: "mcp:closedloop/list-documents",
    name: "list-documents",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "closedloop",
    harness: Harness.Codex,
    invocations: 410,
    sessions: 180,
    locPerDollar: 6300,
    trend: [4, 5, 5, 6, 6, 6, 6, 6],
  },
  {
    id: "mcp:closedloop/update-document",
    name: "update-document",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "closedloop",
    harness: Harness.Codex,
    invocations: 180,
    sessions: 90,
    locPerDollar: 6000,
    trend: [4, 4, 5, 5, 5, 5, 6, 6],
  },
  {
    id: "mcp:context7/get-library-docs",
    name: "get-library-docs",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "context7",
    harness: Harness.Claude,
    invocations: 320,
    sessions: 140,
    locPerDollar: 5900,
    trend: [4, 5, 5, 5, 5, 6, 6, 6],
  },
  {
    id: "mcp:asana/search_tasks",
    name: "search_tasks",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "asana",
    harness: Harness.Claude,
    invocations: 130,
    sessions: 70,
    locPerDollar: 5600,
    trend: [4, 4, 5, 5, 5, 5, 5, 5],
  },
  {
    id: "mcp:node_repl/node_eval",
    name: "node_eval",
    kind: AgentComponentKind.Mcp,
    sourceType: SourceType.Server,
    source: "node_repl",
    harness: Harness.Codex,
    invocations: 104,
    sessions: 40,
    locPerDollar: 5300,
    trend: [4, 4, 5, 5, 5, 5, 5, 5],
  },
  // Workflows (saved orchestration / CI automation)
  {
    id: "workflow:desktop-release",
    name: "desktop-release",
    kind: AgentComponentKind.Workflow,
    sourceType: SourceType.Repo,
    source: "symphony-alpha",
    harness: Harness.Both,
    invocations: 24,
    sessions: 19,
    locPerDollar: 7400,
    trend: [3, 4, 4, 5, 5, 6, 6, 6],
  },
  {
    id: "workflow:symphony-evaluation",
    name: "symphony-evaluation",
    kind: AgentComponentKind.Workflow,
    sourceType: SourceType.Repo,
    source: "agent-evaluation-framework",
    harness: Harness.Both,
    invocations: 60,
    sessions: 41,
    locPerDollar: 6600,
    trend: [4, 5, 5, 5, 6, 6, 6, 7],
  },
  {
    id: "workflow:session-review",
    name: "session-review",
    kind: AgentComponentKind.Workflow,
    sourceType: SourceType.Repo,
    source: "astoria-service",
    harness: Harness.Both,
    invocations: 40,
    sessions: 30,
    locPerDollar: 6300,
    trend: [3, 4, 4, 5, 5, 5, 6, 6],
  },
  {
    id: "workflow:game-prototype",
    name: "game-prototype",
    kind: AgentComponentKind.Workflow,
    sourceType: SourceType.Repo,
    source: "BMAD-METHOD",
    harness: Harness.Both,
    invocations: 8,
    sessions: 3,
    locPerDollar: 5400,
    trend: [2, 3, 3, 4, 4, 4, 5, 5],
  },
  {
    id: "workflow:publish-npm",
    name: "publish-npm",
    kind: AgentComponentKind.Workflow,
    sourceType: SourceType.Repo,
    source: "acplugin",
    harness: Harness.Both,
    invocations: 18,
    sessions: 12,
    locPerDollar: 5800,
    trend: [3, 3, 4, 4, 4, 5, 5, 5],
  },
  // Hooks (configured — no reliable usage logs)
  {
    id: "hook:pre-commit-lint",
    name: "pre-commit-lint",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Repo,
    source: "symphony-alpha",
    harness: Harness.Both,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "hook:post-write-format",
    name: "post-write-format",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Codex,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "hook:guard-secrets",
    name: "guard-secrets",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Pack,
    source: "code",
    harness: Harness.Claude,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "hook:pre-push-blocker",
    name: "pre-push-blocker",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Repo,
    source: "claude-plugins",
    harness: Harness.Both,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "hook:notification",
    name: "notification",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Local,
    source: "Local",
    harness: Harness.Claude,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "hook:codex-notify",
    name: "codex-notify",
    kind: AgentComponentKind.Hook,
    sourceType: SourceType.Local,
    source: "Local",
    harness: Harness.Codex,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  // Memory & config (file-defined cascade)
  {
    id: "config:CLAUDE.md-database",
    name: "CLAUDE.md (database)",
    kind: AgentComponentKind.Config,
    sourceType: SourceType.Scope,
    source: "Directory",
    harness: Harness.Claude,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "config:AGENTS.md",
    name: "AGENTS.md",
    kind: AgentComponentKind.Config,
    sourceType: SourceType.Scope,
    source: "Repo",
    harness: Harness.Both,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "config:AGENTS.md-global",
    name: "AGENTS.md (global)",
    kind: AgentComponentKind.Config,
    sourceType: SourceType.Scope,
    source: "User",
    harness: Harness.Codex,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "config:settings.json",
    name: "settings.json",
    kind: AgentComponentKind.Config,
    sourceType: SourceType.Scope,
    source: "Project",
    harness: Harness.Claude,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
  {
    id: "config:settings.json-global",
    name: "settings.json (global)",
    kind: AgentComponentKind.Config,
    sourceType: SourceType.Scope,
    source: "User",
    harness: Harness.Claude,
    invocations: null,
    sessions: null,
    locPerDollar: null,
    trend: [],
  },
];

// ---------------------------------------------------------------------------
// Sessions — the runs that invoked a component (detail-page "where used")
// ---------------------------------------------------------------------------

export const SessionState = {
  Active: "ACTIVE",
  Waiting: "WAITING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Abandoned: "ABANDONED",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export type MockSession = {
  id: string;
  user: string;
  name: string;
  state: SessionState;
  pack: string | null;
  components: readonly string[];
  locPerDollar: number;
  cost: string;
  startedAgo: string;
  /** Component version that ran in this session (set at the detail layer). */
  version?: string;
};

// Stable accent per user, reused by the usage chart legend and session rows.
export const USER_COLORS: Record<string, string> = {
  "Maya Chen": "#e11d48",
  "Devon Park": "#6366f1",
  "Sasha Ortiz": "#10b981",
  "Imani Reid": "#f59e0b",
  "Kenji Tan": "#8b5cf6",
  "Ada Nunez": "#0891b2",
};

export const mockSessions: readonly MockSession[] = [
  {
    id: "ses_8f2a91",
    user: "Maya Chen",
    name: "Webhook migration — execute",
    state: SessionState.Active,
    pack: "code",
    components: ["playwright-helper", "get_pull_request", "/code-review"],
    locPerDollar: 8800,
    cost: "$0.38",
    startedAgo: "2 minutes ago",
  },
  {
    id: "ses_8f2a74",
    user: "Devon Park",
    name: "Inbox v2 — code review",
    state: SessionState.Active,
    pack: "code-review",
    components: ["visual-qa-agent", "get_pull_request"],
    locPerDollar: 7700,
    cost: "$0.09",
    startedAgo: "6 minutes ago",
  },
  {
    id: "ses_8f2a52",
    user: "Imani Reid",
    name: "Doc toolbar — visual QA",
    state: SessionState.Active,
    pack: "code",
    components: ["visual-qa-agent", "prototype"],
    locPerDollar: 9000,
    cost: "$0.11",
    startedAgo: "12 minutes ago",
  },
  {
    id: "ses_8f2a18",
    user: "Sasha Ortiz",
    name: "SAML SSO — implementation plan",
    state: SessionState.Waiting,
    pack: "bootstrap",
    components: ["ai-agent-orchestration-expert", "/bootstrap:start"],
    locPerDollar: 8100,
    cost: "$0.42",
    startedAgo: "38 minutes ago",
  },
  {
    id: "ses_8f29e0",
    user: "Maya Chen",
    name: "Migrate repositoryOverrides",
    state: SessionState.Completed,
    pack: null,
    components: ["pytest-runner", "902_ai_python_developer"],
    locPerDollar: 7000,
    cost: "$1.04",
    startedAgo: "1 hour ago",
  },
  {
    id: "ses_8f29c3",
    user: "Ada Nunez",
    name: "Streaming PRD — chat spike",
    state: SessionState.Waiting,
    pack: "self-learning",
    components: ["figma-analytics-extractor", "decision-table"],
    locPerDollar: 6600,
    cost: "$0.04",
    startedAgo: "1 hour ago",
  },
  {
    id: "ses_8f2988",
    user: "Kenji Tan",
    name: "Workstream re-org — explore",
    state: SessionState.Failed,
    pack: null,
    components: ["add-converter"],
    locPerDollar: 5000,
    cost: "$0.03",
    startedAgo: "3 hours ago",
  },
  {
    id: "ses_8f2951",
    user: "Devon Park",
    name: "GH Actions integration — execute",
    state: SessionState.Abandoned,
    pack: null,
    components: ["desktop-release", "pre-commit-lint"],
    locPerDollar: 5800,
    cost: "$0.86",
    startedAgo: "yesterday",
  },
  {
    id: "ses_8f2a05",
    user: "Kenji Tan",
    name: "Auth rate limiting — implementation",
    state: SessionState.Active,
    pack: "code",
    components: ["/code-review", "prototype", "get_pull_request"],
    locPerDollar: 7400,
    cost: "$0.52",
    startedAgo: "18 minutes ago",
  },
  {
    id: "ses_8f29b1",
    user: "Ada Nunez",
    name: "Billing webhook retries — code review",
    state: SessionState.Active,
    pack: "code-review",
    components: ["visual-qa-agent", "/code-review"],
    locPerDollar: 6900,
    cost: "$0.21",
    startedAgo: "42 minutes ago",
  },
  {
    id: "ses_8f2977",
    user: "Sasha Ortiz",
    name: "Search reindex job — execute",
    state: SessionState.Completed,
    pack: "bootstrap",
    components: ["/bootstrap:start", "pytest-runner"],
    locPerDollar: 7800,
    cost: "$0.93",
    startedAgo: "2 hours ago",
  },
  {
    id: "ses_8f2940",
    user: "Imani Reid",
    name: "Onboarding flow polish — visual QA",
    state: SessionState.Active,
    pack: "code",
    components: ["visual-qa-agent", "prototype", "figma-analytics-extractor"],
    locPerDollar: 8300,
    cost: "$0.17",
    startedAgo: "3 hours ago",
  },
  {
    id: "ses_8f2912",
    user: "Devon Park",
    name: "Flaky test triage — explore",
    state: SessionState.Waiting,
    pack: null,
    components: ["pytest-runner", "decision-table"],
    locPerDollar: 6200,
    cost: "$0.34",
    startedAgo: "5 hours ago",
  },
  {
    id: "ses_8f28e6",
    user: "Maya Chen",
    name: "Dashboard KPI labels — implementation",
    state: SessionState.Waiting,
    pack: "self-learning",
    components: ["/code-review", "decision-table", "prototype"],
    locPerDollar: 7100,
    cost: "$0.61",
    startedAgo: "yesterday",
  },
];
