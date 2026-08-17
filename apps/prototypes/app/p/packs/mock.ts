// Packs page — mock data.
//
// The multiplayer web experience for pack discovery: a shared catalog of the
// packs (marketplaces bundling agents, skills, commands, and hooks) the team
// installs across harnesses. Models the real `Pack` domain
// (packages/design-system/components/ui/types.ts) plus the team-usage fields the
// web surface adds — installers, install trend, and per-content-item detail.
// Presentational, mock-only. No dates; deterministic ordering.

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
  | "packs"
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
  { label: "Agents", icon: "agents" },
  { label: "Packs", icon: "packs", isActive: true },
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
// Team members (installers)
// ---------------------------------------------------------------------------

export const TEAM_MEMBERS: readonly string[] = [
  "Maya Chen",
  "Devon Park",
  "Sasha Ortiz",
  "Imani Reid",
  "Kenji Tan",
  "Ada Nunez",
  "Parker Byrd",
  "Tomas Vidal",
];

// Stable accent per member, reused by the avatar stacks and activity feed.
export const USER_COLORS: Record<string, string> = {
  "Maya Chen": "#e11d48",
  "Devon Park": "#6366f1",
  "Sasha Ortiz": "#10b981",
  "Imani Reid": "#f59e0b",
  "Kenji Tan": "#8b5cf6",
  "Ada Nunez": "#0891b2",
  "Parker Byrd": "#db2777",
  "Tomas Vidal": "#2563eb",
};

export const TEAM_SIZE = TEAM_MEMBERS.length;

// The signed-in member. Packs this member installed render as "Installed";
// everyone else's installs drive the team-usage numbers.
export const CURRENT_USER = "Parker Byrd";

// ---------------------------------------------------------------------------
// Pack catalog model
// ---------------------------------------------------------------------------

export const Harness = {
  Claude: "claude",
  Codex: "codex",
  Both: "both",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

// A pack bundles these kinds of components. Mirrors PackContentItem.kind plus
// hooks, which the web detail view surfaces explicitly.
export const PackContentKind = {
  Agent: "agent",
  Skill: "skill",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
} as const;

export type PackContentKind =
  (typeof PackContentKind)[keyof typeof PackContentKind];

export type PackContentItem = {
  name: string;
  kind: PackContentKind;
  description: string;
};

export const PackCategory = {
  Coding: "Coding",
  Review: "Review",
  Planning: "Planning",
  Analytics: "Analytics",
  Platform: "Platform",
  Automation: "Automation",
} as const;

export type PackCategory = (typeof PackCategory)[keyof typeof PackCategory];

// Whether a pack is publicly listed in the marketplace or private to the org.
export const PackVisibility = {
  Public: "public",
  Private: "private",
} as const;

export type PackVisibility =
  (typeof PackVisibility)[keyof typeof PackVisibility];

export type Pack = {
  id: string;
  name: string;
  /** Author / marketplace org shown under the name. */
  publisher: string;
  category: PackCategory;
  description: string;
  githubUrl: string;
  stars: number;
  /** Verified by the ClosedLoop marketplace. */
  verified: boolean;
  harnesses: readonly Harness[];
  /** Team members who have installed the pack (drives the install count). */
  installers: readonly string[];
  /** Whether the current user has it installed. */
  installedByMe: boolean;
  /** Weekly install counts across the team, oldest to newest (sparkline). */
  installTrend: readonly number[];
  contents: readonly PackContentItem[];
};

// Count helpers keep the card and detail views reading the same numbers.
export const installCount = (pack: Pack): number => pack.installers.length;

export const contentCountByKind = (pack: Pack, kind: PackContentKind): number =>
  pack.contents.filter((item) => item.kind === kind).length;

// ---------------------------------------------------------------------------
// Performance (ideation) — how sessions that use a pack compare to similar
// sessions that don't. Derived deterministically from the pack id so the mock
// stays stable across renders; every field is a directional sample, not a real
// measurement.
// ---------------------------------------------------------------------------

export type PackPerformance = {
  /**
   * % fewer tokens per comparable task vs. sessions without the pack. Can go
   * negative (the pack costs MORE tokens than baseline). See
   * `PERFORMANCE_OVERRIDES` below.
   */
  tokenEfficiencyDelta: number;
  /** 8-point efficiency trend for a sparkline (oldest to newest). */
  efficiencyTrend: readonly number[];
  /** Average reviewer/judge score, 0-10. */
  qualityScore: number;
  /** % higher quality vs. baseline. */
  qualityDelta: number;
  /** Merged lines of code per dollar. */
  locPerDollar: number;
  /** % of sessions that reach a merged PR. */
  successRate: number;
  /**
   * % higher success rate vs. baseline. A relative percent, not percentage
   * points, so the MetricCard delta chip's "%" reads true. Can go negative
   * (see below).
   */
  successDelta: number;
};

const PERF_HASH_MODULUS = 1_000_003;
const perfHash = (seed: string): number => {
  let hash = 7;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % PERF_HASH_MODULUS;
  }
  return hash;
};

// A couple of packs regress on purpose. The hash-derived deltas below floor
// positive for every pack, so MetricCard's losing-case styling (the red chip,
// the "worse" verdict) never renders anywhere in this sandbox unless a mock
// pack actually trails baseline on something.
const PERFORMANCE_OVERRIDES: Partial<
  Record<
    string,
    Partial<Pick<PackPerformance, "tokenEfficiencyDelta" | "successDelta">>
  >
> = {
  // Verified, five installers. A real regression, not just a young pack.
  posthog: { tokenEfficiencyDelta: -8 },
  // Unverified automation pack: sessions using it are less likely to land.
  "self-learning": { successDelta: -4 },
};

export const performanceFor = (pack: Pack): PackPerformance => {
  const h = perfHash(pack.id);
  const override = PERFORMANCE_OVERRIDES[pack.id];
  const tokenEfficiencyDelta = override?.tokenEfficiencyDelta ?? 9 + (h % 21);
  const qualityScore = Number((7 + (Math.floor(h / 4) % 24) / 10).toFixed(1));
  const efficiencyBase = 4 + (h % 3);
  return {
    tokenEfficiencyDelta,
    efficiencyTrend: Array.from(
      { length: 8 },
      (_, index) =>
        efficiencyBase + Math.round((index * tokenEfficiencyDelta) / 12)
    ),
    qualityScore,
    qualityDelta: 4 + (Math.floor(h / 8) % 13),
    // LOC/$ lands in the thousands of merged lines per dollar (matching the
    // agents surface's ~4,100 baseline), not the single digits the KLOC/$ unit
    // used to show.
    locPerDollar: 4100 + (Math.floor(h / 16) % 45) * 100,
    successRate: 82 + (Math.floor(h / 64) % 16),
    successDelta: override?.successDelta ?? 3 + (Math.floor(h / 2) % 9),
  };
};

// Team members who cherry-picked some (not all) of a pack's agents/skills rather
// than installing the whole pack. Derived deterministically from members who are
// not full installers, so the three cohorts (installed / partially / not) stay
// disjoint. Sample data.
export const partialInstallersFor = (pack: Pack): readonly string[] => {
  const nonInstallers = TEAM_MEMBERS.filter(
    (member) => !pack.installers.includes(member)
  );
  if (nonInstallers.length === 0) {
    return [];
  }
  const h = perfHash(`${pack.id}:partial`);
  const count = Math.min(nonInstallers.length, 1 + (h % 2));
  const start = h % nonInstallers.length;
  return Array.from(
    { length: count },
    (_, index) => nonInstallers[(start + index) % nonInstallers.length]
  );
};

// Public/private listing per pack. Org-internal tooling is private; community
// packs are public.
const PACK_VISIBILITY: Record<string, PackVisibility> = {
  code: PackVisibility.Private,
  "code-review": PackVisibility.Private,
  posthog: PackVisibility.Public,
  platform: PackVisibility.Private,
  "self-learning": PackVisibility.Private,
  bootstrap: PackVisibility.Public,
  judges: PackVisibility.Private,
  conductor: PackVisibility.Public,
  superpowers: PackVisibility.Public,
  gstack: PackVisibility.Public,
};

export const visibilityFor = (pack: Pack): PackVisibility =>
  PACK_VISIBILITY[pack.id] ?? PackVisibility.Public;

// Which of a pack's components the current user has installed. A fully-installed
// pack has every component checked; a user who cherry-picked (partial installer)
// has a deterministic subset; everyone else has none. Sample data.
export const installedComponentNamesFor = (pack: Pack): ReadonlySet<string> => {
  if (pack.installedByMe) {
    return new Set(pack.contents.map((item) => item.name));
  }
  if (!partialInstallersFor(pack).includes(CURRENT_USER)) {
    return new Set();
  }
  const h = perfHash(`${pack.id}:mine`);
  const picked = pack.contents
    .filter((_, index) => Math.floor(h / 2 ** index) % 2 === 0)
    .map((item) => item.name);
  // Keep the partial state visible: at least one checked, never all of them.
  if (picked.length === 0 && pack.contents.length > 0) {
    return new Set([pack.contents[0].name]);
  }
  if (picked.length === pack.contents.length) {
    picked.pop();
  }
  return new Set(picked);
};

export const mockPacks: readonly Pack[] = [
  {
    id: "code",
    name: "code",
    publisher: "closedloop-ai",
    category: PackCategory.Coding,
    description:
      "The end-to-end coding loop: plan, execute, verify, and learn. Ships the planning agents, the implementation orchestrator, and the build validator the team leans on daily.",
    githubUrl: "https://github.com/closedloop-ai/code",
    stars: 2140,
    verified: true,
    harnesses: [Harness.Both],
    installers: [
      "Maya Chen",
      "Devon Park",
      "Sasha Ortiz",
      "Imani Reid",
      "Kenji Tan",
      "Ada Nunez",
      "Parker Byrd",
      "Tomas Vidal",
    ],
    installedByMe: true,
    installTrend: [3, 4, 4, 5, 6, 6, 7, 8],
    contents: [
      {
        name: "plan-agent",
        kind: PackContentKind.Agent,
        description: "Software architect that drafts and revises plans.",
      },
      {
        name: "code-reviewer",
        kind: PackContentKind.Agent,
        description: "Reviews changes for bugs, security, and quality.",
      },
      {
        name: "build-validator",
        kind: PackContentKind.Agent,
        description: "Discovers and runs test, lint, typecheck, and build.",
      },
      {
        name: "/code",
        kind: PackContentKind.Command,
        description: "Begin a coding session.",
      },
      {
        name: "/create-plan",
        kind: PackContentKind.Command,
        description: "Create an implementation plan.",
      },
      {
        name: "/execute-implementation",
        kind: PackContentKind.Command,
        description: "Execute an approved implementation plan.",
      },
      {
        name: "decision-table",
        kind: PackContentKind.Skill,
        description: "Code-grounded control-flow decision tables.",
      },
      {
        name: "plan-structure",
        kind: PackContentKind.Skill,
        description: "Conventions for creating and updating plans.",
      },
      {
        name: "pre-commit-lint",
        kind: PackContentKind.Hook,
        description: "Blocks commits that fail lint or typecheck.",
      },
    ],
  },
  {
    id: "code-review",
    name: "code-review",
    publisher: "closedloop-ai",
    category: PackCategory.Review,
    description:
      "Multi-agent review fleet: bug hunters, a unified auditor, and adversarial verifiers that confirm findings before they reach the diff.",
    githubUrl: "https://github.com/closedloop-ai/code-review",
    stars: 1680,
    verified: true,
    harnesses: [Harness.Both],
    installers: [
      "Maya Chen",
      "Devon Park",
      "Imani Reid",
      "Kenji Tan",
      "Ada Nunez",
      "Parker Byrd",
    ],
    installedByMe: true,
    installTrend: [2, 3, 3, 4, 4, 5, 6, 6],
    contents: [
      {
        name: "code-review-worker",
        kind: PackContentKind.Agent,
        description: "Partitioned worker that analyzes changed code.",
      },
      {
        name: "code-review-worker-graph",
        kind: PackContentKind.Agent,
        description: "Graph-aware worker for cross-file impact review.",
      },
      {
        name: "/code-review",
        kind: PackContentKind.Command,
        description: "Run a comprehensive review, locally or on a PR.",
      },
      {
        name: "spawn-reviewers",
        kind: PackContentKind.Skill,
        description: "Spawn and collect the reviewer fleet.",
      },
      {
        name: "verify-findings",
        kind: PackContentKind.Skill,
        description: "Adversarially verify findings before reporting.",
      },
      {
        name: "cost",
        kind: PackContentKind.Skill,
        description: "Attribute the token cost of review runs.",
      },
    ],
  },
  {
    id: "posthog",
    name: "posthog",
    publisher: "posthog",
    category: PackCategory.Analytics,
    description:
      "Product analytics from the terminal: query insights, triage errors, audit feature flags, and turn engineering signals into dashboards.",
    githubUrl: "https://github.com/posthog/posthog-pack",
    stars: 3420,
    verified: true,
    harnesses: [Harness.Claude],
    installers: ["Devon Park", "Sasha Ortiz", "Ada Nunez", "Tomas Vidal"],
    installedByMe: false,
    installTrend: [0, 1, 1, 2, 2, 3, 3, 4],
    contents: [
      {
        name: "error-analyzer",
        kind: PackContentKind.Agent,
        description: "Analyzes errors in parallel to find root causes.",
      },
      {
        name: "querying-posthog-data",
        kind: PackContentKind.Skill,
        description: "Author and run analytics queries.",
      },
      {
        name: "investigating-error-issue",
        kind: PackContentKind.Skill,
        description: "Trace an error issue to a session replay.",
      },
      {
        name: "auditing-experiments-flags",
        kind: PackContentKind.Skill,
        description: "Health-check experiments and feature flags.",
      },
      {
        name: "posthog-mcp",
        kind: PackContentKind.Mcp,
        description: "MCP server exposing the PostHog query tools.",
      },
    ],
  },
  {
    id: "platform",
    name: "platform",
    publisher: "closedloop-ai",
    category: PackCategory.Platform,
    description:
      "Author and debug the harness itself: agents, skills, slash commands, hooks, settings, and CLAUDE.md files, plus context-engineering guidance.",
    githubUrl: "https://github.com/closedloop-ai/platform",
    stars: 960,
    verified: true,
    harnesses: [Harness.Claude],
    installers: ["Maya Chen", "Kenji Tan", "Parker Byrd"],
    installedByMe: true,
    installTrend: [1, 1, 2, 2, 2, 3, 3, 3],
    contents: [
      {
        name: "claude-code-expert",
        kind: PackContentKind.Skill,
        description: "Work with agents, skills, commands, and hooks.",
      },
      {
        name: "claude-creator",
        kind: PackContentKind.Skill,
        description: "Scaffold a new skill from scratch.",
      },
      {
        name: "context-engineering",
        kind: PackContentKind.Skill,
        description: "Design prompts and structure context windows.",
      },
      {
        name: "mermaid-visualizer",
        kind: PackContentKind.Skill,
        description: "Render architecture and flow diagrams.",
      },
    ],
  },
  {
    id: "self-learning",
    name: "self-learning",
    publisher: "closedloop-ai",
    category: PackCategory.Automation,
    description:
      "Capture, dedupe, and share the patterns your runs discover, so the whole team's agents get sharper over time.",
    githubUrl: "https://github.com/closedloop-ai/self-learning",
    stars: 540,
    verified: false,
    harnesses: [Harness.Both],
    installers: ["Sasha Ortiz", "Imani Reid", "Ada Nunez"],
    installedByMe: false,
    installTrend: [0, 0, 1, 1, 2, 2, 2, 3],
    contents: [
      {
        name: "process-learnings",
        kind: PackContentKind.Skill,
        description: "Process pending learnings into org patterns.",
      },
      {
        name: "push-learnings",
        kind: PackContentKind.Skill,
        description: "Push local patterns to the shared repository.",
      },
      {
        name: "pull-learnings",
        kind: PackContentKind.Skill,
        description: "Pull shared org patterns into the local set.",
      },
      {
        name: "post-run-capture",
        kind: PackContentKind.Hook,
        description: "Captures learnings when a run completes.",
      },
    ],
  },
  {
    id: "bootstrap",
    name: "bootstrap",
    publisher: "astoria-labs",
    category: PackCategory.Coding,
    description:
      "Spin up a new service the house way: scaffolds the repo, wires CI, and drops in the starter agents a greenfield project needs.",
    githubUrl: "https://github.com/astoria-labs/bootstrap",
    stars: 780,
    verified: false,
    harnesses: [Harness.Both],
    installers: ["Devon Park", "Kenji Tan"],
    installedByMe: false,
    installTrend: [0, 1, 1, 1, 2, 2, 2, 2],
    contents: [
      {
        name: "/bootstrap:start",
        kind: PackContentKind.Command,
        description: "Scaffold a new service from a template.",
      },
      {
        name: "scaffolder",
        kind: PackContentKind.Agent,
        description: "Generates the repo layout and starter files.",
      },
      {
        name: "ci-wiring",
        kind: PackContentKind.Skill,
        description: "Wire GitHub Actions for a new service.",
      },
    ],
  },
  {
    id: "judges",
    name: "judges",
    publisher: "closedloop-ai",
    category: PackCategory.Review,
    description:
      "The evaluation panel: SOLID, DRY, KISS, testability, and goal-alignment judges that score plans and code before they ship.",
    githubUrl: "https://github.com/closedloop-ai/judges",
    stars: 410,
    verified: true,
    harnesses: [Harness.Claude],
    installers: ["Maya Chen", "Imani Reid", "Tomas Vidal", "Ada Nunez"],
    installedByMe: false,
    installTrend: [0, 1, 1, 2, 2, 3, 3, 4],
    contents: [
      {
        name: "kiss-judge",
        kind: PackContentKind.Agent,
        description: "Scores plans for KISS violations.",
      },
      {
        name: "dry-judge",
        kind: PackContentKind.Agent,
        description: "Scores plans for DRY violations.",
      },
      {
        name: "test-judge",
        kind: PackContentKind.Agent,
        description: "Evaluates test coverage and assertion quality.",
      },
      {
        name: "run-judges",
        kind: PackContentKind.Skill,
        description: "Orchestrate parallel judge execution.",
      },
    ],
  },
  {
    id: "conductor",
    name: "conductor",
    publisher: "conductor",
    category: PackCategory.Platform,
    description:
      "Run many coding agents in parallel across isolated worktrees, with workspace setup and review workflows built in.",
    githubUrl: "https://github.com/conductor-build/conductor",
    stars: 1290,
    verified: false,
    harnesses: [Harness.Claude],
    installers: ["Parker Byrd", "Devon Park"],
    installedByMe: true,
    installTrend: [0, 0, 1, 1, 1, 2, 2, 2],
    contents: [
      {
        name: "conductor",
        kind: PackContentKind.Skill,
        description: "Build and troubleshoot Conductor workspaces.",
      },
      {
        name: "worktree-setup",
        kind: PackContentKind.Hook,
        description: "Bootstraps a fresh worktree on creation.",
      },
    ],
  },
  {
    id: "superpowers",
    name: "Superpowers",
    publisher: "superpowers-dev",
    category: PackCategory.Automation,
    description:
      "A curated toolbelt of high-leverage skills: parallel web research, deep verification, and browser automation your agents can reach for on demand.",
    githubUrl: "https://github.com/superpowers-dev/superpowers",
    stars: 1870,
    verified: true,
    harnesses: [Harness.Both],
    installers: [
      "Maya Chen",
      "Devon Park",
      "Sasha Ortiz",
      "Kenji Tan",
      "Ada Nunez",
    ],
    installedByMe: false,
    installTrend: [0, 1, 2, 2, 3, 4, 5, 6],
    contents: [
      {
        name: "deep-research",
        kind: PackContentKind.Skill,
        description: "Fan-out web research with adversarial fact-checking.",
      },
      {
        name: "verify",
        kind: PackContentKind.Skill,
        description: "Run the app and confirm a change actually works.",
      },
      {
        name: "browser-driver",
        kind: PackContentKind.Agent,
        description: "Drives a headless browser for visual QA.",
      },
      {
        name: "web-search",
        kind: PackContentKind.Mcp,
        description: "MCP server for live web search and fetch.",
      },
    ],
  },
  {
    id: "gstack",
    name: "Gstack",
    publisher: "gstack-labs",
    category: PackCategory.Coding,
    description:
      "The Google-stack starter kit: agents and skills for building on Firebase, Cloud Run, and BigQuery with the house conventions baked in.",
    githubUrl: "https://github.com/gstack-labs/gstack",
    stars: 640,
    verified: false,
    harnesses: [Harness.Claude],
    installers: ["Imani Reid", "Tomas Vidal"],
    installedByMe: false,
    installTrend: [0, 0, 0, 1, 1, 1, 2, 2],
    contents: [
      {
        name: "firebase-expert",
        kind: PackContentKind.Agent,
        description: "Reviews Firebase rules, functions, and data models.",
      },
      {
        name: "/deploy-cloud-run",
        kind: PackContentKind.Command,
        description: "Build and deploy a service to Cloud Run.",
      },
      {
        name: "bigquery-schema",
        kind: PackContentKind.Skill,
        description: "Author and evolve BigQuery table schemas.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Team activity feed — recent installs across the team (multiplayer signal)
// ---------------------------------------------------------------------------

export const ActivityAction = {
  Installed: "installed",
  Updated: "updated to a new version of",
} as const;

export type ActivityAction =
  (typeof ActivityAction)[keyof typeof ActivityAction];

export type ActivityEvent = {
  id: string;
  user: string;
  action: ActivityAction;
  packId: string;
  packName: string;
  agoLabel: string;
};

export const mockActivity: readonly ActivityEvent[] = [
  {
    id: "act-1",
    user: "Ada Nunez",
    action: ActivityAction.Installed,
    packId: "posthog",
    packName: "posthog",
    agoLabel: "12 minutes ago",
  },
  {
    id: "act-2",
    user: "Kenji Tan",
    action: ActivityAction.Installed,
    packId: "bootstrap",
    packName: "bootstrap",
    agoLabel: "1 hour ago",
  },
  {
    id: "act-3",
    user: "Maya Chen",
    action: ActivityAction.Updated,
    packId: "code",
    packName: "code",
    agoLabel: "2 hours ago",
  },
  {
    id: "act-4",
    user: "Tomas Vidal",
    action: ActivityAction.Installed,
    packId: "judges",
    packName: "judges",
    agoLabel: "3 hours ago",
  },
  {
    id: "act-5",
    user: "Imani Reid",
    action: ActivityAction.Installed,
    packId: "self-learning",
    packName: "self-learning",
    agoLabel: "yesterday",
  },
  {
    id: "act-6",
    user: "Devon Park",
    action: ActivityAction.Installed,
    packId: "code-review",
    packName: "code-review",
    agoLabel: "yesterday",
  },
];
