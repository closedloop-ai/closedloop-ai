// Agents page — component detail data.
//
// Ported from the Claude Design "app" UI kit (ui_kits/app/AgentsData.jsx
// AG_DETAILS + ag_detailFor, and AgentDetail.jsx usage helpers). One rich
// definition per observed kind; everything else is synthesized from the row.
// All series are deterministic (hashed, never random) so the mock is stable.

import { LOC_PER_DOLLAR_FORMAT, NUMBER_FORMAT } from "./component-meta";
import {
  type AgentComponent,
  AgentComponentKind,
  type MockSession,
  mockComponents,
  mockSessions,
  OWNER_NAMES,
  SessionState,
} from "./mock";

export type DefinitionFormat = "md" | "json" | "yml" | "bash" | "toml";

export type FrontmatterRow = { key: string; value: string };

export type ServerInfo = {
  url: string;
  auth: string;
  health: string;
};

export type ComponentDetail = {
  path: string;
  format: DefinitionFormat;
  frontmatter?: readonly FrontmatterRow[];
  source: string;
  model?: string;
  allowedTools?: readonly string[];
  server?: ServerInfo;
  maxConcurrency?: number;
  orchestrates?: readonly string[];
};

const DEFAULT_FORMAT: Record<AgentComponentKind, DefinitionFormat> = {
  [AgentComponentKind.Skill]: "md",
  [AgentComponentKind.Subagent]: "md",
  [AgentComponentKind.Command]: "md",
  [AgentComponentKind.Workflow]: "yml",
  [AgentComponentKind.Mcp]: "json",
  [AgentComponentKind.Hook]: "bash",
  [AgentComponentKind.Config]: "md",
};

const LEADING_SLASH = /^\//;

const defaultPath = (component: AgentComponent): string => {
  const bare = component.name.replace(LEADING_SLASH, "");
  switch (component.kind) {
    case AgentComponentKind.Skill:
      return `~/.claude/skills/${bare}/SKILL.md`;
    case AgentComponentKind.Subagent:
      return `.claude/agents/${bare}.md`;
    case AgentComponentKind.Command:
      return `.claude/commands/${bare}.md`;
    case AgentComponentKind.Workflow:
      return `.github/workflows/${bare}.yml`;
    case AgentComponentKind.Mcp:
      return ".mcp.json";
    case AgentComponentKind.Hook:
      return `.claude/hooks/${bare}.sh`;
    default:
      return component.name;
  }
};

// MCP server connection configs — the tool's definition is its server file.
const SERVER_INFO: Record<
  string,
  ServerInfo & { path: string; source: string; format: DefinitionFormat }
> = {
  github: {
    url: "https://api.githubcopilot.com/mcp/",
    auth: "API key · bearer",
    health: "Connected",
    path: "external_plugins/github/.mcp.json",
    format: "json",
    source: `{
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer \${GITHUB_PAT}" }
  }
}`,
  },
  closedloop: {
    url: "https://mcp.closedloop.ai/mcp",
    auth: "OAuth · per-tool approval",
    health: "Connected",
    path: "~/.codex/config.toml",
    format: "toml",
    source: `[mcp_servers.closedloop]
url = "https://mcp.closedloop.ai/mcp"

[mcp_servers.closedloop.tools.get-me]
approval_mode = "approve"

[mcp_servers.closedloop.tools.list-loops]
approval_mode = "approve"`,
  },
  context7: {
    url: "stdio · npx @upstash/context7-mcp",
    auth: "None",
    health: "Connected",
    path: "external_plugins/context7/.mcp.json",
    format: "json",
    source: `{
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"]
  }
}`,
  },
  asana: {
    url: "https://mcp.asana.com/sse",
    auth: "OAuth · browser",
    health: "Connected",
    path: "external_plugins/asana/.mcp.json",
    format: "json",
    source: `{
  "asana": {
    "type": "sse",
    "url": "https://mcp.asana.com/sse"
  }
}`,
  },
  node_repl: {
    url: "stdio · node",
    auth: "None",
    health: "Connected",
    path: "~/.codex/config.toml",
    format: "toml",
    source: `[mcp_servers.node_repl]
command = "node"
args = ["./scripts/mcp-repl.mjs"]
startup_timeout_ms = 10000`,
  },
};

// Rich, hand-authored definitions — one representative per observed kind.
const DEFINITIONS: Record<string, ComponentDetail> = {
  "subagent:visual-qa-agent": {
    path: ".claude/agents/visual-qa.md",
    format: "md",
    model: "opus",
    allowedTools: ["Read", "Bash", "mcp__playwright", "Skill"],
    frontmatter: [
      { key: "name", value: "visual-qa-agent" },
      { key: "model", value: "opus" },
      { key: "color", value: "blue" },
      {
        key: "description",
        value:
          "Visual QA specialist. Launches browser, navigates pages, screenshots, validates UI.",
      },
    ],
    source: `---
name: visual-qa-agent
description: Visual QA specialist for the web application. Launches a browser,
  navigates to pages, takes screenshots, and validates UI requirements.
model: opus
color: blue
---

You are a Visual QA specialist for the Astoria web application. Use browser
automation to visually verify UI requirements.

**MANDATORY: Before starting ANY validation work, invoke the Playwright
testing skill:**

    Skill("symphony-fe:playwright-testing")

## Inputs

1. **$RUN** — Optional run directory path passed by the caller
2. **Validation prompt** — Description of what to verify
3. **--attachment <path>** — Reference image(s) for visual comparison
4. **--auto-login** — Force automatic login using E2E credentials (CI)`,
  },
  "command:/code-review": {
    path: "plugins/code-review/commands/code-review.md",
    format: "md",
    frontmatter: [
      { key: "name", value: "code-review" },
      { key: "argument-hint", value: "[--detailed]" },
      {
        key: "description",
        value:
          "Execute a code review using specialized agents on changed files.",
      },
    ],
    source: `# Code Review Command

Execute a code review using specialized agents on changed files.

## Usage

    /code-review [--detailed]

## Description

Runs a multi-step code review with intelligent file detection:

1. **Staged files first** — \`git diff --cached --name-only\`
2. **Branch fallback** — \`git diff main --name-only\`
3. **Error on main** — reports if on main with no staged files

**Default steps**:

1. Code Quality Review (code-reviewer)
2. Type Safety Analysis (type-system-architect)
3. Test Coverage Review (test-engineer)`,
  },
  "skill:pytest-runner": {
    path: ".claude/skills/pytest-runner/SKILL.md",
    format: "md",
    frontmatter: [
      { key: "name", value: "pytest-runner" },
      {
        key: "description",
        value:
          "Run pytest test suites with real-time output monitoring via tail.",
      },
    ],
    source: `---
name: pytest-runner
description: Run pytest test suites with real-time output monitoring via tail.
---

# Pytest Runner

Run pytest with real-time output monitoring, log capture, and JUnit XML for
structured analysis.

The script automatically determines optimal parallelization:

- **Full test suite**: \`-n auto\` for maximum efficiency
- **Small sets (<= 4 tests)**: \`-n <count>\` to match worker count
- **Large sets (> 8 tests)**: \`-n auto\` to leverage all CPU cores

## Quick start

    run_tests.sh tests/            # live output + log + JUnit XML
    run_tests.sh -s tests/         # with summary of results
    run_tests.sh -b -s tests/      # background mode with tail monitoring`,
  },
  "workflow:desktop-release": {
    path: ".github/workflows/desktop-release.yml",
    format: "yml",
    maxConcurrency: 4,
    orchestrates: ["visual-qa-agent"],
    source: `name: Release Desktop

on:
  # Slack-context inputs mirror deploy-production.yml so the loops bot can
  # dispatch \`@loops release desktop\` into a thread. All Slack inputs are
  # OPTIONAL — a bare manual workflow_dispatch must still run.
  workflow_dispatch:
    inputs:
      slack_thread_ts: { required: false }

jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm release:preflight`,
  },
};

const genericSource = (component: AgentComponent): string =>
  `# ${component.name}\n\nThe definition for this ${component.kind} has not been recreated in the kit. In the live product this pane renders the component's source file (${defaultPath(component)}).`;

export const detailFor = (component: AgentComponent): ComponentDetail => {
  const registered = DEFINITIONS[component.id];
  if (registered) {
    return registered;
  }
  if (component.kind === AgentComponentKind.Mcp) {
    const server = SERVER_INFO[component.source];
    if (server) {
      return {
        path: server.path,
        format: server.format,
        source: server.source,
        server: {
          url: server.url,
          auth: server.auth,
          health: server.health,
        },
      };
    }
  }
  return {
    path: defaultPath(component),
    format: DEFAULT_FORMAT[component.kind],
    source: genericSource(component),
  };
};

// ---------------------------------------------------------------------------
// Version history — Agents, Skills, and Commands are versioned; each edit to
// the prompt bumps the version. Sessions/branches record which version ran.
// ---------------------------------------------------------------------------

export type ComponentVersion = {
  id: string;
  createdAgo: string;
  isCurrent: boolean;
  source: string;
};

const VERSION_AGO = [
  "3 days ago",
  "2 weeks ago",
  "1 month ago",
  "2 months ago",
  "4 months ago",
];

const hashInt = (seed: string, span: number): number =>
  Math.floor(hashUnit(seed) * span);

// Total versions for a component (3-5), newest first. The current version keeps
// the live prompt; older versions are shorter, earlier revisions of it.
export const versionsFor = (
  component: AgentComponent,
  currentSource: string
): readonly ComponentVersion[] => {
  const count = 3 + hashInt(`${component.id}:versions`, 3);
  const lines = currentSource.split("\n");
  return Array.from({ length: count }, (_, offset) => {
    const number = count - offset;
    const isCurrent = offset === 0;
    const trimmed = lines
      .slice(0, Math.max(6, lines.length - offset * 4))
      .join("\n");
    return {
      id: `v${number}`,
      isCurrent,
      createdAgo: isCurrent ? "Current" : (VERSION_AGO[offset - 1] ?? "Older"),
      source: isCurrent
        ? currentSource
        : `# Revision v${number} (earlier draft)\n\n${trimmed}`,
    };
  });
};

// Deterministically pick which version a given session/branch ran, biased toward
// the current version so the column reads realistically.
export const versionUsed = (
  versions: readonly ComponentVersion[],
  seed: string
): string => {
  const roll = hashUnit(`${seed}:version`);
  if (roll < 0.55) {
    return versions[0].id;
  }
  return versions[hashInt(`${seed}:version-pick`, versions.length)].id;
};

// ---------------------------------------------------------------------------
// Usage — sessions where a component ran, plus a per-day-by-user series
// ---------------------------------------------------------------------------

const SESSIONS_SHOWN = 10;

// Sessions the component was seen in: direct references first, then pack-mates,
// then the rest of the pool as filler — capped so the table shows a healthy 8-10
// rows for every component (it's a mock; padding keeps the table populated).
export const sessionsFor = (
  component: AgentComponent
): readonly MockSession[] => {
  const direct = mockSessions.filter((session) =>
    session.components.includes(component.name)
  );
  const byPack = mockSessions.filter(
    (session) => session.pack !== null && session.pack === component.source
  );
  const ordered: MockSession[] = [];
  const seen = new Set<string>();
  for (const group of [direct, byPack, mockSessions]) {
    for (const session of group) {
      if (!seen.has(session.id)) {
        seen.add(session.id);
        ordered.push(session);
      }
    }
  }
  return ordered.slice(0, SESSIONS_SHOWN);
};

// 14 consecutive day labels ending on the createdAt date (static — no Date()).
export const USAGE_DAY_LABELS: readonly string[] = [
  "Jun 22",
  "Jun 23",
  "Jun 24",
  "Jun 25",
  "Jun 26",
  "Jun 27",
  "Jun 28",
  "Jun 29",
  "Jun 30",
  "Jul 1",
  "Jul 2",
  "Jul 3",
  "Jul 4",
  "Jul 5",
];

const DEFAULT_TREND = [4, 5, 5, 6, 6, 7, 7, 8];

// Deterministic pseudo-random value in [0, 1) — a polynomial rolling hash
// (no bitwise ops) so the mock series stays stable across renders.
const HASH_MODULUS = 1_000_000_007;
const hashUnit = (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % HASH_MODULUS;
  }
  return (hash % 1000) / 1000;
};

export type UsageDay = {
  label: string;
  total: number;
  byUser: Record<string, number>;
};

export type UsageSeries = {
  days: readonly UsageDay[];
  users: readonly string[];
  max: number;
};

export const usageSeries = (
  component: AgentComponent,
  sessions: readonly MockSession[]
): UsageSeries => {
  const users = [...new Set(sessions.map((session) => session.user))];
  if (users.length === 0) {
    users.push("Maya Chen");
  }
  const total = component.invocations ?? 200;
  const trend = component.trend.length > 0 ? component.trend : DEFAULT_TREND;
  const dayCount = USAGE_DAY_LABELS.length;

  const raw = USAGE_DAY_LABELS.map((_, index) => {
    const trendValue =
      trend[Math.floor((index / dayCount) * trend.length)] ?? 5;
    const jitter = 0.6 + hashUnit(`${component.name}:${index}`) * 0.8;
    return Math.max(0, trendValue * jitter);
  });
  const rawSum = raw.reduce((sum, value) => sum + value, 0) || 1;

  const days: UsageDay[] = USAGE_DAY_LABELS.map((label, index) => {
    const dayTotal = Math.round((raw[index] / rawSum) * total);
    const byUser: Record<string, number> = {};
    let remaining = dayTotal;
    users.forEach((user, userIndex) => {
      if (userIndex === users.length - 1) {
        byUser[user] = remaining;
        return;
      }
      const share = 0.2 + hashUnit(`${component.name}:${user}:${index}`) * 0.5;
      const value = Math.min(remaining, Math.round(dayTotal * share));
      byUser[user] = value;
      remaining -= value;
    });
    return { label, total: dayTotal, byUser };
  });

  const max = Math.max(...days.map((day) => day.total), 1);
  return { days, users, max };
};

// ---------------------------------------------------------------------------
// Per-owner breakdown of the average (the detail "breakdown table")
// ---------------------------------------------------------------------------

export type UsageBreakdownRow = {
  user: string;
  invocations: number;
  sessions: number;
  avgPerSession: number;
};

export type UsageBreakdown = {
  rows: readonly UsageBreakdownRow[];
  totalInvocations: number;
  totalSessions: number;
  avgPerSession: number;
};

export const usageBreakdown = (
  component: AgentComponent,
  sessions: readonly MockSession[]
): UsageBreakdown => {
  const series = usageSeries(component, sessions);
  const rows = series.users.map((user) => {
    const invocations = series.days.reduce(
      (sum, day) => sum + (day.byUser[user] ?? 0),
      0
    );
    const userSessions =
      sessions.filter((session) => session.user === user).length || 1;
    return {
      user,
      invocations,
      sessions: userSessions,
      avgPerSession: Math.round(invocations / userSessions),
    };
  });
  const totalInvocations = rows.reduce((sum, row) => sum + row.invocations, 0);
  const totalSessions = rows.reduce((sum, row) => sum + row.sessions, 0);
  return {
    rows,
    totalInvocations,
    totalSessions,
    avgPerSession: Math.round(totalInvocations / (totalSessions || 1)),
  };
};

// ---------------------------------------------------------------------------
// Agent-special — the sub-agents, tools, and commands an agent pulled in,
// always resolved through the sessions it ran in (#7)
// ---------------------------------------------------------------------------

export type ResolvedUsage = {
  subagents: readonly string[];
  tools: readonly string[];
  commands: readonly string[];
};

const KIND_BY_NAME = new Map(
  mockComponents.map((component) => [component.name, component.kind])
);

const EXTRA_SPAWNED = ["visual-qa-agent", "type-system-architect"];
const EXTRA_TOOLS = ["get_pull_request", "search_code", "Bash"];

const uniqueCapped = (values: readonly string[], cap: number): string[] =>
  [...new Set(values)].slice(0, cap);

export const resolvedThroughSessions = (
  component: AgentComponent,
  sessions: readonly MockSession[]
): ResolvedUsage => {
  const names = sessions.flatMap((session) => session.components);
  const subagents: string[] = [...EXTRA_SPAWNED];
  const tools: string[] = [...EXTRA_TOOLS];
  const commands: string[] = [];
  for (const name of names) {
    if (name === component.name) {
      continue;
    }
    const kind = KIND_BY_NAME.get(name);
    if (kind === AgentComponentKind.Subagent) {
      subagents.push(name);
    } else if (kind === AgentComponentKind.Command || name.startsWith("/")) {
      commands.push(name);
    } else {
      tools.push(name);
    }
  }
  return {
    subagents: uniqueCapped(subagents, 6),
    tools: uniqueCapped(tools, 6),
    commands: uniqueCapped(commands, 6),
  };
};

// ---------------------------------------------------------------------------
// Top cards — a handful of numbers, the last one varying by type (#6)
// ---------------------------------------------------------------------------

export type DetailCard = {
  key: string;
  label: string;
  value: string;
  hint: string;
};

const typeSpecificCard = (
  component: AgentComponent,
  sessions: readonly MockSession[]
): DetailCard => {
  const resolved = resolvedThroughSessions(component, sessions);
  switch (component.kind) {
    case AgentComponentKind.Subagent:
      return {
        key: "tools",
        label: "Tools used",
        value: String(resolved.tools.length),
        hint: "distinct tools, resolved through its sessions",
      };
    case AgentComponentKind.Skill:
      return {
        key: "avg",
        label: "Avg / session",
        value:
          component.invocations && component.sessions
            ? String(Math.round(component.invocations / component.sessions))
            : "—",
        hint: "mean invocations per session",
      };
    default:
      return {
        key: "invocations",
        label: "Invocations",
        value:
          component.invocations === null
            ? "—"
            : NUMBER_FORMAT.format(component.invocations),
        hint: "total calls in range",
      };
  }
};

export const topCards = (
  component: AgentComponent,
  sessions: readonly MockSession[]
): readonly DetailCard[] => {
  const owners = new Set(sessions.map((session) => session.user)).size;
  const mostActive = [...usageBreakdown(component, sessions).rows].sort(
    (a, b) => b.invocations - a.invocations
  )[0];
  return [
    {
      key: "sessions",
      label: "Sessions",
      value: String(sessions.length),
      hint: "distinct sessions it appeared in",
    },
    {
      key: "owners",
      label: "Owners",
      value: String(owners),
      hint: mostActive
        ? `most active: ${mostActive.user}`
        : "no owners in range",
    },
    typeSpecificCard(component, sessions),
  ];
};

// ---------------------------------------------------------------------------
// Anchored session timeline — the sequence of turns/tool calls in one session,
// with the current component's uses marked as dots (#4 anchored, #5 markers)
// ---------------------------------------------------------------------------

export const SessionEventKind = {
  Human: "human",
  Assistant: "assistant",
  Tool: "tool",
  Skill: "skill",
  Command: "command",
  Subagent: "subagent",
  Review: "review",
  Done: "done",
} as const;

export type SessionEventKind =
  (typeof SessionEventKind)[keyof typeof SessionEventKind];

export type SessionEvent = {
  id: string;
  kind: SessionEventKind;
  label: string;
  isComponentUse: boolean;
};

const componentUseKind = (kind: AgentComponentKind): SessionEventKind => {
  switch (kind) {
    case AgentComponentKind.Skill:
      return SessionEventKind.Skill;
    case AgentComponentKind.Command:
      return SessionEventKind.Command;
    case AgentComponentKind.Subagent:
    case AgentComponentKind.Workflow:
      return SessionEventKind.Subagent;
    default:
      return SessionEventKind.Tool;
  }
};

const componentUseLabel = (component: AgentComponent): string => {
  switch (component.kind) {
    case AgentComponentKind.Skill:
      return `Skill("${component.name}")`;
    case AgentComponentKind.Subagent:
      return `Task("${component.name}")`;
    case AgentComponentKind.Workflow:
      return `Workflow: ${component.name}`;
    case AgentComponentKind.Mcp:
      return `mcp__${component.source}__${component.name}`;
    case AgentComponentKind.Command:
      return component.name;
    default:
      return `Loaded ${component.name}`;
  }
};

type TimelineSlot =
  | { slot: number }
  | { kind: SessionEventKind; label: string };

const TIMELINE_TEMPLATE: readonly TimelineSlot[] = [
  { kind: SessionEventKind.Human, label: "__PROMPT__" },
  { kind: SessionEventKind.Assistant, label: "Scoped the request" },
  { kind: SessionEventKind.Tool, label: "Read — project layout" },
  { kind: SessionEventKind.Command, label: "/gh-daily-summary" },
  { slot: 0 },
  { kind: SessionEventKind.Tool, label: "Grep — call sites" },
  { kind: SessionEventKind.Assistant, label: "Applied edits" },
  { slot: 1 },
  { kind: SessionEventKind.Subagent, label: "visual-qa-agent" },
  { slot: 2 },
  { kind: SessionEventKind.Review, label: "Code review pass" },
  { kind: SessionEventKind.Done, label: "Session completed" },
];

export const sessionTimeline = (
  component: AgentComponent,
  session: MockSession
): readonly SessionEvent[] => {
  const useKind = componentUseKind(component.kind);
  const useLabel = componentUseLabel(component);
  const useCount =
    1 + Math.floor(hashUnit(`${component.id}:${session.id}`) * 3);
  const events: SessionEvent[] = [];
  let index = 0;
  for (const item of TIMELINE_TEMPLATE) {
    if ("slot" in item) {
      if (item.slot < useCount) {
        events.push({
          id: `${session.id}-${index}`,
          kind: useKind,
          label: useLabel,
          isComponentUse: true,
        });
        index += 1;
      }
      continue;
    }
    const label =
      item.label === "__PROMPT__" ? `"${session.name}"` : item.label;
    events.push({
      id: `${session.id}-${index}`,
      kind: item.kind,
      label,
      isComponentUse: false,
    });
    index += 1;
  }
  return events;
};

export const firstUseIndex = (events: readonly SessionEvent[]): number =>
  events.findIndex((event) => event.isComponentUse);

// ---------------------------------------------------------------------------
// Branches — delivered-code units where the component contributed. Efficiency
// (value per dollar) lives here only, since cost attributes to merged code (#3).
// ---------------------------------------------------------------------------

export const BranchState = {
  Merged: "merged",
  Open: "open",
  Draft: "draft",
} as const;

export type BranchState = (typeof BranchState)[keyof typeof BranchState];

export type Branch = {
  id: string;
  title: string;
  repo: string;
  owner: string;
  /** Component version that ran on this branch (set at the detail layer). */
  version?: string;
  prNumber: number;
  state: BranchState;
  locPerDollar: number;
  cost: string;
  additions: number;
  deletions: number;
  sessions: number;
  uses: number;
  mergedAgo: string;
};

const BRANCH_TEMPLATES: readonly { title: string; repo: string }[] = [
  { title: "Harden webhook replay handling", repo: "symphony-alpha" },
  { title: "Inbox v2 saved filters", repo: "symphony-alpha" },
  { title: "SAML SSO groundwork", repo: "astoria-service" },
  { title: "Dashboard KPI unit labels", repo: "astoria-frontend" },
  { title: "Prompt cache hit metrics", repo: "agent-evaluation-framework" },
];

const BRANCH_AGO = ["2 days ago", "5 days ago", "1 week ago", "2 weeks ago"];
const BRANCH_STATES: readonly BranchState[] = [
  BranchState.Merged,
  BranchState.Merged,
  BranchState.Open,
];

export const branchesFor = (component: AgentComponent): readonly Branch[] => {
  const base = component.locPerDollar ?? 5.5;
  const start = Math.floor(hashUnit(component.id) * BRANCH_TEMPLATES.length);
  return Array.from({ length: 3 }, (_, offset) => {
    const template =
      BRANCH_TEMPLATES[(start + offset) % BRANCH_TEMPLATES.length];
    const seed = hashUnit(`${component.id}:branch:${offset}`);
    const sessions = 2 + Math.floor(seed * 4);
    return {
      id: `branch-${component.id}-${offset}`,
      title: template.title,
      repo: template.repo,
      owner:
        OWNER_NAMES[
          Math.floor(
            hashUnit(`${component.id}:branch-owner:${offset}`) *
              OWNER_NAMES.length
          )
        ],
      prNumber: 2100 + Math.floor(seed * 800),
      state: BRANCH_STATES[offset] ?? BranchState.Merged,
      locPerDollar: Math.max(
        2,
        Math.round((base + (seed - 0.5) * 3) * 10) / 10
      ),
      cost: `$${(3 + seed * 9).toFixed(2)}`,
      additions: 120 + Math.floor(seed * 900),
      deletions: 20 + Math.floor(seed * 300),
      sessions,
      uses: sessions * (1 + Math.floor(seed * 3)),
      mergedAgo: BRANCH_AGO[offset % BRANCH_AGO.length],
    };
  });
};

// ---------------------------------------------------------------------------
// Display-ready row metadata for the shared Sessions/Branches tables. The base
// mock lacks repo/branch/PR fields, so they are synthesized deterministically.
// ---------------------------------------------------------------------------

const SESSION_REPOS = ["symphony-alpha", "astoria-frontend", "astoria-service"];
const SLUG_NON_ALNUM = /[^a-z0-9]+/g;
const TRIM_DASHES = /^-+|-+$/g;

const slugify = (text: string): string =>
  text.toLowerCase().replace(SLUG_NON_ALNUM, "-").replace(TRIM_DASHES, "");

export type SessionRowMeta = {
  repo: string;
  branch: string;
  prNumber: number;
  prMerged: boolean;
};

export const sessionRowMeta = (session: MockSession): SessionRowMeta => {
  const seed = hashUnit(session.id);
  return {
    repo: SESSION_REPOS[Math.floor(seed * SESSION_REPOS.length)],
    branch: `feat/${slugify(session.name)}`,
    prNumber: 2100 + Math.floor(seed * 800),
    prMerged: session.state === SessionState.Completed,
  };
};

export const branchDisplayName = (branch: Branch): string =>
  `feat/${slugify(branch.title)}`;

// ---------------------------------------------------------------------------
// Component-level metrics row (above the Sessions/Branches tabs). The card set
// varies by kind.
// ---------------------------------------------------------------------------

export type ComponentMetric = {
  key: string;
  label: string;
  value: string;
  info?: { what: string; how?: string };
};

const METRIC_DASH = "—";

export const componentMetrics = (
  component: AgentComponent
): readonly ComponentMetric[] => {
  const branches = branchesFor(component);
  const merged = branches.filter(
    (branch) => branch.state === BranchState.Merged
  ).length;
  const linesShipped = branches.reduce(
    (sum, branch) => sum + branch.additions,
    0
  );
  const totalCost = branches.reduce(
    (sum, branch) => sum + (Number(branch.cost.replace("$", "")) || 0),
    0
  );
  const avgPerSession =
    component.invocations && component.sessions
      ? Math.round(component.invocations / component.sessions)
      : null;

  const numOrDash = (value: number | null): string =>
    value === null ? METRIC_DASH : NUMBER_FORMAT.format(value);

  const locPerDollarCard: ComponentMetric = {
    key: "loc-per-dollar",
    label: "LOC / $",
    // Same formatter as the list column and its summary card (component-meta's
    // LOC_PER_DOLLAR_FORMAT) so the number does not change shape between the
    // list and the detail page.
    value:
      component.locPerDollar === null
        ? METRIC_DASH
        : LOC_PER_DOLLAR_FORMAT.format(component.locPerDollar),
    info: {
      what: "Merged lines per dollar across sessions that used it. Higher is better.",
      how: "Read this as a trend, not a score. It's a session-level metric, not caused by one component.",
    },
  };
  const invocationsCard: ComponentMetric = {
    key: "invocations",
    label: "Invocations",
    value: numOrDash(component.invocations),
    info: { what: "Total calls attributed to this component in range." },
  };
  const sessionsCard: ComponentMetric = {
    key: "sessions",
    label: "Sessions",
    value: numOrDash(component.sessions),
  };
  const mergedCard: ComponentMetric = {
    key: "merged",
    label: "Merged PRs",
    value: String(merged),
  };

  if (component.kind === AgentComponentKind.Subagent) {
    return [
      locPerDollarCard,
      invocationsCard,
      sessionsCard,
      mergedCard,
      { key: "lines", label: "Lines shipped", value: numOrDash(linesShipped) },
      { key: "cost", label: "Total cost", value: `$${totalCost.toFixed(2)}` },
    ];
  }

  return [
    locPerDollarCard,
    invocationsCard,
    sessionsCard,
    mergedCard,
    {
      key: "avg",
      label: "Avg / session",
      value: avgPerSession === null ? METRIC_DASH : String(avgPerSession),
    },
  ];
};
