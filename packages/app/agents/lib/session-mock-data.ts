// Generic primitives stay in design-system; domain types come from the new
// App Core domain home (see session-types.ts migration note).
import type {
  FilterField,
  Metric,
  TabItem,
} from "@repo/design-system/components/ui/types";
import {
  Activity,
  Bot,
  FolderOpen,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import type {
  ActivityItem,
  AlwaysAllowRule,
  Approval,
  CliTool,
  DashboardSeriesPoint,
  Job,
  LogEntry,
  Pack,
  PackDetail,
  PackInstallRun,
  Plan,
  PullRequest,
  SavedConfig,
  SessionOverviewStats,
  SessionRow,
  Skill,
  ToolEvent,
  WorkflowData,
} from "./session-types";

export const tabs: TabItem[] = [
  { value: "monitor", label: "Monitor", count: 182, icon: Activity },
  { value: "sessions", label: "Sessions", count: 48, icon: FolderOpen },
  { value: "activity", label: "Activity", count: 12, icon: Workflow },
  { value: "settings", label: "Settings", icon: ShieldCheck },
];

export const metrics: Metric[] = [
  {
    label: "Active sessions",
    value: 18,
    detail: "6 awaiting input",
    trend: "+3 this hour",
    icon: FolderOpen,
  },
  {
    label: "Running agents",
    value: 44,
    detail: "Across Claude, Codex, Cursor, Copilot",
    trend: "+11%",
    icon: Bot,
  },
  {
    label: "Events processed",
    value: "28.4k",
    detail: "Realtime ingest healthy",
    trend: "+1.8k",
    icon: Activity,
  },
  {
    label: "Estimated cost",
    value: "$219.43",
    detail: "Last 30 days",
    trend: "-8.2%",
    icon: Sparkles,
  },
];

export const series: DashboardSeriesPoint[] = [
  { label: "Mon", sessions: 14, events: 320 },
  { label: "Tue", sessions: 17, events: 410 },
  { label: "Wed", sessions: 13, events: 360 },
  { label: "Thu", sessions: 22, events: 520 },
  { label: "Fri", sessions: 19, events: 470 },
  { label: "Sat", sessions: 11, events: 260 },
  { label: "Sun", sessions: 15, events: 310 },
];

export const filters: FilterField[] = [
  {
    id: "status",
    label: "Status",
    value: "",
    options: [
      { value: "", label: "All statuses" },
      { value: "active", label: "Active" },
      { value: "waiting", label: "Waiting" },
      { value: "completed", label: "Completed" },
      { value: "error", label: "Error" },
    ],
  },
  {
    id: "harness",
    label: "Harness",
    value: "",
    options: [
      { value: "", label: "All harnesses" },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "cursor", label: "Cursor" },
      { value: "copilot", label: "Copilot" },
    ],
  },
];

export const sessions: SessionRow[] = [
  {
    id: "sess-1",
    name: "Design-system extraction",
    repo: "/workspace/symphony-alpha",
    model: "gpt-5.5",
    harness: "codex",
    status: "active",
    startedAt: "2026-05-28T09:10:00.000Z",
    lastActivity: "2026-05-28T15:21:00.000Z",
    cost: 18.94,
    agents: 3,
    totalTokens: 318_000,
    durationLabel: "6h 11m",
    isRunDriven: true,
    runHref: "/run?session=sess-1",
  },
  {
    id: "sess-2",
    name: "Desktop renderer tab normalization",
    repo: "/workspace/closedloop-electron",
    model: "claude-opus-4.1",
    harness: "claude",
    status: "waiting",
    startedAt: "2026-05-28T08:00:00.000Z",
    lastActivity: "2026-05-28T15:14:00.000Z",
    cost: 32.18,
    agents: 5,
    totalTokens: 284_000,
    durationLabel: "Running",
    awaitingInputSince: "2026-05-28T15:07:00.000Z",
  },
  {
    id: "sess-3",
    name: "PR telemetry patch",
    repo: "/workspace/closedloop-electron",
    model: "claude-sonnet-4.6",
    harness: "claude",
    status: "completed",
    startedAt: "2026-05-27T12:05:00.000Z",
    lastActivity: "2026-05-27T13:43:00.000Z",
    cost: 7.42,
    agents: 2,
    totalTokens: 201_000,
    durationLabel: "1h 38m",
  },
  {
    id: "sess-4",
    name: "Catalog sync triage",
    repo: "/workspace/claude-plugins",
    model: "cursor-max",
    harness: "cursor",
    status: "error",
    startedAt: "2026-05-27T18:02:00.000Z",
    lastActivity: "2026-05-27T18:51:00.000Z",
    cost: 5.87,
    agents: 1,
    totalTokens: 96_000,
    durationLabel: "49m",
  },
];

export const sessionControls = {
  title: "Sessions",
  countLabel: "48 sessions",
  isLive: true,
  liveLabel: "Live",
  offlineLabel: "Offline",
  searchPlaceholder: "Search sessions, repos, models",
  searchValue: "design-system",
  directoryValue: "",
  directoryOptions: [
    { value: "", label: "All directories" },
    {
      value: "/workspace/symphony-alpha",
      label: "symphony-alpha",
    },
    {
      value: "/workspace/closedloop-electron",
      label: "closedloop-electron",
    },
    {
      value: "/workspace/claude-plugins",
      label: "claude-plugins",
    },
  ],
  harnessValue: "",
  harnessOptions: [
    { value: "", label: "All Harnesses" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
    { value: "cursor", label: "Cursor" },
    { value: "copilot", label: "Copilot" },
    { value: "opencode", label: "OpenCode" },
  ],
  statusValue: "",
  statusOptions: [
    { value: "", label: "All" },
    { value: "active", label: "Active" },
    { value: "waiting", label: "Waiting" },
    { value: "completed", label: "Completed" },
    { value: "error", label: "Error" },
    { value: "abandoned", label: "Abandoned" },
  ],
  sortValue: "time",
  sortOptions: [
    { value: "time", label: "Sort by Time" },
    { value: "duration", label: "Sort by Duration" },
    { value: "price", label: "Sort by Price" },
  ],
  sortDescending: true,
  refreshLabel: "Refresh",
} satisfies import("./session-types").SessionControls;

export const sessionsPagination = {
  page: 0,
  pageSize: 10,
  total: 48,
  totalPages: 5,
} satisfies import("@repo/design-system/components/ui/types").PaginationState;

export const activities: ActivityItem[] = [
  {
    id: "event-1",
    method: "GET",
    title: "Sessions snapshot refreshed",
    badge: "200",
    tone: "success",
    time: "2026-05-28T15:21:00.000Z",
    session: "Design-system extraction",
    summary:
      "Reconciled Codex, Claude, and Cursor sessions into one normalized view.",
    details: [
      { label: "Path", value: "/api/sessions?limit=50" },
      { label: "Body", value: '{ "filters": { "status": "all" } }' },
    ],
  },
  {
    id: "event-2",
    method: "POST",
    title: "Approval requested for fetch",
    badge: "Security",
    tone: "danger",
    time: "2026-05-28T15:18:00.000Z",
    session: "Desktop renderer tab normalization",
    summary:
      "A fetch against origin/main required escalation outside the sandbox.",
    details: [{ label: "Operation", value: "git fetch origin main" }],
  },
  {
    id: "event-3",
    method: "PATCH",
    title: "CLI tool override saved",
    badge: "Custom",
    tone: "info",
    time: "2026-05-28T14:57:00.000Z",
    summary:
      "Git path override persisted for a detached desktop test environment.",
  },
];

export const runSessionRecord = {
  handle: {
    id: "run-42",
    title: "Run design-system extraction",
    promptPreview:
      "Port the remaining upstream Run and CcConfig surfaces into shared DS composites.",
    status: "running",
    mode: "conversation",
    cwd: "/workspace/symphony-alpha",
    model: "gpt-5.5",
    permissionMode: "acceptEdits",
    startedAt: "2026-05-28T16:20:00.000Z",
    sessionId: "sess-1",
  },
  transcript: {
    id: "run-transcript-main",
    label: "Main run",
    agentLabel: "Main agent",
    status: "working",
    totalMessages: 7,
    hasMoreHistory: true,
    newMessagesAvailable: true,
    messages: [
      {
        id: "run-message-1",
        role: "user",
        author: "You",
        createdAt: "2026-05-28T16:20:00.000Z",
        content:
          "Port the remaining upstream Run and CcConfig surfaces into shared DS composites without duplicating primitives.",
      },
      {
        id: "run-message-2",
        role: "assistant",
        author: "Codex",
        createdAt: "2026-05-28T16:20:12.000Z",
        content:
          "I’m decomposing the remaining upstream surfaces into shared UI layers now. I’ll start with the Run workspace because most of its stream rendering can be rebuilt from the message, code, and tool-call primitives already in the design system.",
        blocks: [
          {
            type: "text",
            text: "I’m decomposing the remaining upstream surfaces into shared UI layers now. I’ll start with the Run workspace because most of its stream rendering can be rebuilt from the message, code, and tool-call primitives already in the design system.",
          },
          {
            type: "tool_use",
            id: "tool-run-1",
            name: "exec_command",
            input: {
              command: 'rg -n "RunSession|ConfigCard|StatusPill" Run.tsx',
            },
          },
          {
            type: "tool_result",
            id: "tool-run-1",
            output:
              "Located RunSession, ConfigCard, StatusPill, TokenMeter, and the active-runs/history surfaces in the upstream page.",
          },
        ],
      },
      {
        id: "run-message-3",
        role: "assistant",
        author: "Codex",
        createdAt: "2026-05-28T16:22:11.000Z",
        content:
          "The next DS-owned workspace will combine run configuration, active runs, and transcript output into one canonical composition.",
        blocks: [
          {
            type: "thinking",
            text: "The correct merge boundary is the workspace plus the run-summary list items, not another embedded page wrapper.",
          },
          {
            type: "text",
            text: "The next DS-owned workspace will combine run configuration, active runs, and transcript output into one canonical composition.",
          },
        ],
      },
    ],
    envelopes: [
      {
        id: "run-system-1",
        type: "system",
        createdAt: "2026-05-28T16:20:00.000Z",
        model: "gpt-5.5",
        cwd: "/workspace/symphony-alpha",
        permissionMode: "acceptEdits",
        sessionId: "sess-1",
      },
      {
        id: "run-message-1",
        type: "user",
        author: "You",
        createdAt: "2026-05-28T16:20:00.000Z",
        content: [
          {
            type: "text",
            text: "Port the remaining upstream Run and CcConfig surfaces into shared DS composites without duplicating primitives.",
          },
        ],
      },
      {
        id: "run-message-2",
        type: "assistant",
        author: "Codex",
        createdAt: "2026-05-28T16:20:12.000Z",
        content: [
          {
            type: "text",
            text: "I’m decomposing the remaining upstream surfaces into shared UI layers now. I’ll start with the Run workspace because most of its stream rendering can be rebuilt from the message, code, and tool-call primitives already in the design system.",
          },
          {
            type: "tool_use",
            id: "tool-run-1",
            name: "exec_command",
            input: {
              command: 'rg -n "RunSession|ConfigCard|StatusPill" Run.tsx',
            },
          },
        ],
        usage: {
          outputTokens: 312,
        },
      },
      {
        id: "run-tool-result-1",
        type: "user",
        author: "System",
        createdAt: "2026-05-28T16:20:13.000Z",
        content: [
          {
            type: "tool_result",
            id: "tool-run-1",
            output:
              "Located RunSession, ConfigCard, StatusPill, TokenMeter, and the active-runs/history surfaces in the upstream page.",
          },
        ],
      },
      {
        id: "run-message-3",
        type: "assistant",
        author: "Codex",
        createdAt: "2026-05-28T16:22:11.000Z",
        streaming: true,
        content: [
          {
            type: "thinking",
            text: "The correct merge boundary is the workspace plus the run-summary list items, not another embedded page wrapper.",
          },
          {
            type: "text",
            text: "The next DS-owned workspace will combine run configuration, active runs, and transcript output into one canonical composition.",
          },
        ],
        usage: {
          inputTokens: 604,
          outputTokens: 198,
        },
      },
      {
        id: "run-result-1",
        type: "result",
        createdAt: "2026-05-28T16:34:00.000Z",
        durationMs: 840_000,
        turns: 7,
        costUsd: 3.82,
        result:
          "Next slice: promote the live envelope renderer into the session conversation panel and activity drill-ins.",
      },
    ],
  },
  followUp:
    "Favor shared chips, buttons, and list items over one-off wrappers.",
  tokenUsage: {
    inputTokens: 18_600,
    outputTokens: 9800,
    cacheReadTokens: 7200,
    cacheCreationTokens: 0,
    contextWindow: 200_000,
  },
  result: {
    durationLabel: "14m",
    turns: 7,
    costUsd: 3.82,
  },
} satisfies import("./session-types").RunSessionRecord;

export const cliTools: CliTool[] = [
  {
    id: "claude",
    name: "Claude",
    description: "Used for Claude Code session ingestion and hook wiring.",
    path: "/Applications/Claude.app/Contents/MacOS/Claude",
    hint: "Detected from the installed desktop app bundle.",
    state: "detected",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Used for Codex session capture and approval prompts.",
    path: "/usr/local/bin/codex",
    hint: "Custom override saved for this machine.",
    state: "custom",
  },
  {
    id: "python3",
    name: "Python 3",
    description: "Required by importers and pack install tooling.",
    path: "/tmp/venv/bin/python3",
    hint: "This path does not exist or is not executable.",
    state: "invalid",
  },
  {
    id: "git",
    name: "Git",
    description:
      "Required for PR extraction, diff inspection, and repo metadata.",
    path: "",
    hint: "Reset to auto-detect or provide a valid executable path.",
    state: "missing",
  },
];

export const jobs: Job[] = [
  {
    id: "job-1",
    command: "deploy-preview",
    label: "branch/view-scoped-sync",
    status: "RUNNING",
    startedAt: "2026-05-28T15:02:00.000Z",
    repoPath: "/workspace/symphony-alpha",
    phase: "Waiting for preview environment health check",
  },
  {
    id: "job-2",
    command: "redeploy-production",
    label: "incident-replay",
    status: "FAILED",
    startedAt: "2026-05-28T13:10:00.000Z",
    updatedAt: "2026-05-28T13:19:00.000Z",
    repoPath: "/workspace/symphony-alpha",
    phase: "Build step timed out while warming lambda assets",
  },
];

export const approvals: Approval[] = [
  {
    id: "approval-1",
    title: "Run git push origin codex/design-system-port",
    risk: "medium",
    status: "pending",
    reason: "Pushes a feature branch to GitHub for PR creation.",
    scope: "closedloop-ai/symphony-alpha",
    createdAt: "2026-05-28T15:16:00.000Z",
  },
  {
    id: "approval-2",
    title: "Fetch origin/main in sibling repo",
    risk: "low",
    status: "always-allow",
    reason: "Reads remote refs only; no working tree changes.",
    scope: "/workspace/closedloop-electron",
    createdAt: "2026-05-28T14:40:00.000Z",
  },
];

export const savedConfigs: SavedConfig[] = [
  { id: "cfg-1", name: "Production relay", hasApiKey: true, active: true },
  { id: "cfg-2", name: "Preview sandbox", hasApiKey: false },
  { id: "cfg-3", name: "Local API debug", hasApiKey: true },
];

export const logs: LogEntry[] = [
  {
    id: "log-1",
    timestamp: "2026-05-28T15:22:01.000Z",
    level: "info",
    tag: "desktop",
    message: "Relay registration completed; monitor iframe route sync enabled.",
  },
  {
    id: "log-2",
    timestamp: "2026-05-28T15:22:16.000Z",
    level: "warn",
    tag: "gateway",
    message: "Approval queue is backlogged; 2 requests remain pending.",
  },
  {
    id: "log-3",
    timestamp: "2026-05-28T15:23:04.000Z",
    level: "error",
    tag: "agent-monitor",
    message: "Pack catalog refresh failed due to GitHub secondary rate limit.",
    previousSession: true,
  },
];

export const plans: Plan[] = [
  {
    id: "plan-1",
    title:
      "Disaggregate monitor and desktop surfaces into design-system components",
    status: "captured",
    harness: "codex",
    captureMethod: "hook",
    confidence: 0.98,
    updatedAt: "2026-05-28T15:08:00.000Z",
    sessionId: "sess-1",
    planFile: "/workspace/closedloop-electron/docs/port.md",
    logFile:
      "/workspace/closedloop-electron/.closedloop-ai/context/plan-1.jsonl",
    versions: [
      {
        id: "plan-1-v1",
        version: 1,
        content:
          "1. Inventory all native desktop and embedded monitor surfaces.\n2. Extract canonical primitives.\n3. Build reusable composites.\n4. Add exhaustive Storybook coverage.",
        createdAt: "2026-05-28T14:32:00.000Z",
      },
      {
        id: "plan-1-v2",
        version: 2,
        content:
          "1. Normalize tabs, badges, cards, and list rows.\n2. Add approvals, jobs, keys, logs, plans, tools, skills, PRs, and packs.\n3. Migrate route-level surfaces onto these components.",
        createdAt: "2026-05-28T15:08:00.000Z",
      },
    ],
  },
];

export const toolEvents: ToolEvent[] = [
  {
    id: "tool-event-1",
    type: "PreToolUse",
    summary:
      "Indexed renderer and design-system files before extracting components.",
    createdAt: "2026-05-28T15:21:00.000Z",
    sessionId: "sess-1",
  },
  {
    id: "tool-event-2",
    type: "PostToolUse",
    summary: "Applied patch for the monitor toolbar accessibility fix.",
    createdAt: "2026-05-28T15:26:00.000Z",
    sessionId: "sess-1",
  },
];

export const skills: Skill[] = [
  {
    id: "skill-1",
    name: "deploy-checklist",
    pack: "gstack",
    harness: "claude",
    version: "2.1.0",
    description: "Guides safe deploy sequencing and rollback checks.",
    invocationCount: 32,
    lastInvokedAt: "2026-05-28T12:14:00.000Z",
    invocations: [
      {
        id: "inv-1",
        sessionName: "Deploy incident rehearsal",
        harness: "claude",
        model: "claude-opus-4.1",
        cwd: "/workspace/symphony-alpha",
        createdAt: "2026-05-28T12:14:00.000Z",
      },
    ],
  },
  {
    id: "skill-2",
    name: "db-diff",
    pack: "Unattributed / user-defined",
    harness: "codex",
    invocationCount: 8,
    lastInvokedAt: "2026-05-28T09:42:00.000Z",
    invocations: [
      {
        id: "inv-2",
        sessionName: "Preview schema registry fix",
        harness: "codex",
        model: "gpt-5.5",
        cwd: "/workspace/symphony-alpha",
        createdAt: "2026-05-28T09:42:00.000Z",
      },
    ],
  },
];

export const pullRequests: PullRequest[] = [
  {
    id: "pr-1",
    repo: "closedloop-ai/symphony-alpha",
    number: 1328,
    title: "Port monitor surfaces into design-system primitives",
    url: "https://github.com/closedloop-ai/symphony-alpha/pull/1328",
    branch: "codex/design-system-port",
    harness: "codex",
    state: "open",
    author: "mike-angstadt",
    observedAt: "2026-05-28T15:37:00.000Z",
  },
  {
    id: "pr-2",
    repo: "closedloop-ai/closedloop-electron",
    number: 286,
    title: "Expose additional desktop monitor wiring",
    url: "https://github.com/closedloop-ai/closedloop-electron/pull/286",
    branch: "loop/pln-286",
    harness: "claude",
    state: "merged",
    author: "closedloop-bot",
    observedAt: "2026-05-27T19:04:00.000Z",
  },
  {
    id: "pr-3",
    repo: "closedloop-ai/symphony-alpha",
    number: 1331,
    title: "Normalize shared PR compositions for engineering and desktop",
    url: "https://github.com/closedloop-ai/symphony-alpha/pull/1331",
    branch: "codex/pr-composition-unification",
    harness: "codex",
    state: "open",
    author: "review-agent",
    observedAt: "2026-05-28T16:04:00.000Z",
  },
];

export const packs: Pack[] = [
  {
    id: "gstack",
    displayName: "gstack",
    category: "Workflow",
    description:
      "Branch stacking and PR management helpers for Claude Code and Codex.",
    stars: 1420,
    harnesses: ["claude", "codex"],
    installedHarnesses: ["claude", "codex"],
    installedSkillCount: 14,
    usageCount: 83,
    githubUrl: "https://github.com/gstack-ai/gstack",
    marketplaceUrl: "https://github.com/anthropics/claude-plugins-official",
    installNotes:
      "Codex install path is a superset of the Claude setup and can satisfy both harnesses in one pass.",
    singleInstall: true,
    usage: {
      toolCalls: 83,
      sessions: 19,
      firstUsedAt: "2026-04-14T09:00:00.000Z",
      lastUsedAt: "2026-05-28T14:55:00.000Z",
    },
    history: [
      { label: "Jan", stars: 1110 },
      { label: "Feb", stars: 1195 },
      { label: "Mar", stars: 1270 },
      { label: "Apr", stars: 1362 },
      { label: "May", stars: 1420 },
    ],
  },
  {
    id: "bmad-method",
    displayName: "BMad Method",
    category: "Planning",
    description: "Planning and review playbooks with install-time prompts.",
    stars: 680,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedSkillCount: 0,
    usageCount: 19,
    githubUrl: "https://github.com/bmad-code-org/BMAD-METHOD",
    projectScoped: true,
    uninstalledAt: "2026-05-22T18:20:00.000Z",
    usage: {
      toolCalls: 19,
      sessions: 6,
      firstUsedAt: "2026-04-29T16:00:00.000Z",
      lastUsedAt: "2026-05-22T17:40:00.000Z",
    },
    history: [
      { label: "Jan", stars: 520 },
      { label: "Feb", stars: 560 },
      { label: "Mar", stars: 604 },
      { label: "Apr", stars: 649 },
      { label: "May", stars: 680 },
    ],
  },
  {
    id: "context7",
    displayName: "context7",
    category: "Context",
    description: "MCP-backed documentation retrieval with optional API keys.",
    stars: 934,
    harnesses: ["claude", "codex"],
    installedHarnesses: [],
    installedSkillCount: 0,
    usageCount: 0,
    githubUrl: "https://github.com/upstash/context7",
    placeholderReason:
      "Catalog entry discovered from marketplace metadata only.",
    history: [
      { label: "Jan", stars: 710 },
      { label: "Feb", stars: 768 },
      { label: "Mar", stars: 810 },
      { label: "Apr", stars: 873 },
      { label: "May", stars: 934 },
    ],
  },
];

export const packDetail: PackDetail = {
  pack: packs[0]!,
  verified: true,
  githubUrl: "https://github.com/gstack-ai/gstack",
  marketplaceUrl: "https://github.com/anthropics/claude-plugins-official",
  readme:
    "# gstack\n\nManage stacked branches and pull requests across Claude Code and Codex.\n\n- `/stack-prs`\n- `/rebase-stack`\n- `/merge-stack`",
  installCommands: [
    {
      harness: "claude",
      command: "claude plugins install gstack",
      installed: true,
      actionLabel: "Installed",
    },
    {
      harness: "codex",
      command: "codex plugins install gstack",
      installed: true,
      actionLabel: "Installed",
      commandIsAutoDetect: true,
    },
  ],
  installs: [
    {
      harness: "claude",
      path: "~/.claude/plugins/gstack",
      kind: "directory",
      version: "2.4.1",
    },
    {
      harness: "codex",
      path: "~/.codex/plugins/gstack",
      kind: "directory",
      version: "2.4.1",
    },
  ],
  contents: [
    {
      name: "stack-prs",
      kind: "command",
      description: "Create or update a PR stack from the current branch chain.",
      path: "~/.claude/plugins/gstack/commands/stack-prs.md",
    },
    {
      name: "rebase-stack",
      kind: "command",
      description: "Replay a stacked branch chain on top of latest main.",
      path: "~/.claude/plugins/gstack/commands/rebase-stack.md",
    },
    {
      name: "review-assistant",
      kind: "agent",
      description: "Companion agent for stacked review summaries.",
      category: "Review",
      skillCount: 3,
      skills: ["branch-diff", "dependency-audit", "rollup-summary"],
    },
  ],
  skills: ["/stack-prs", "/rebase-stack", "/merge-stack", "/branch-plan"],
  sessions: sessions.slice(0, 2),
};

export const alwaysAllowRules: AlwaysAllowRule[] = [
  {
    id: "rule-1",
    operationId: "git_action",
    method: "POST",
    path: "/api/gateway/git/status",
    scopePath: "/workspace/symphony-alpha",
    expiresAt: "2026-06-02T12:00:00.000Z",
  },
  {
    id: "rule-2",
    operationId: "repos_config",
    method: "GET",
    path: "/api/gateway/repos",
    expiresAt: "2026-05-29T15:00:00.000Z",
  },
];

export const packInstallRun: PackInstallRun = {
  action: "install",
  harness: "auto",
  command: "./setup --host codex",
  commandIsAutoDetect: true,
  projectScoped: true,
  state: "complete",
  exitCode: 0,
  lines: [
    "Cloning gstack into ~/.claude/plugins/gstack",
    "Detected codex and claude; using shared install path",
    "Running ./setup --host codex",
    "Install completed successfully",
  ],
  projectOptions: [
    "/workspace/symphony-alpha",
    "/workspace/closedloop-electron",
  ],
  selectedProject: "/workspace/symphony-alpha",
  postInstall: {
    title: "Next steps",
    body: "Run the verification command in your terminal to ensure the helper scripts were added to both harnesses.",
    copyCommand: "gstack doctor --verify",
    required: false,
  },
};

export const sessionOverviewStats: SessionOverviewStats = {
  totalEvents: 1284,
  toolCalls: 424,
  subagents: 9,
  compactions: 3,
  errors: 2,
  durationLabel: "4h 18m",
  eventRateHint: "5/min",
  topTools: [
    { toolName: "exec_command", count: 424 },
    { toolName: "write_stdin", count: 86 },
    { toolName: "apply_patch", count: 47 },
    { toolName: "update_plan", count: 9 },
  ],
  subagentTypes: [
    { label: "reviewer", count: 4 },
    { label: "planner", count: 2 },
    { label: "verifier", count: 2 },
    { label: "Context Compaction", count: 3, isCompaction: true },
  ],
  tokens: {
    cacheReadTokens: 40_200_000,
    cacheWriteTokens: 0,
    inputTokens: 42_600_000,
    outputTokens: 255_900,
  },
  eventMix: [
    { eventType: "tool_use", count: 612 },
    { eventType: "tool_result", count: 507 },
    { eventType: "agent_start", count: 12 },
    { eventType: "agent_stop", count: 10 },
    { eventType: "compaction", count: 3 },
  ],
  activeAgent: {
    name: "reviewer",
    currentTool: "exec_command",
    task: "Validate Storybook parity and upstream visual champions",
  },
};

export const workflowData: WorkflowData = {
  stats: {
    totalSessions: 182,
    totalAgents: 514,
    totalSubagents: 338,
    avgSubagents: 1.9,
    successRate: 93,
    avgDepth: 2.4,
    avgDurationSec: 1584,
    totalCompactions: 74,
    avgCompactions: 0.4,
    topFlow: {
      source: "Read",
      target: "Edit",
      count: 126,
    },
  },
  orchestration: {
    sessionCount: 182,
    mainCount: 182,
    subagentTypes: [
      { subagentType: "reviewer", count: 86, completed: 80, errors: 4 },
      { subagentType: "planner", count: 74, completed: 69, errors: 2 },
      { subagentType: "researcher", count: 58, completed: 49, errors: 5 },
      { subagentType: "verifier", count: 47, completed: 43, errors: 2 },
      { subagentType: "release", count: 29, completed: 24, errors: 3 },
    ],
    edges: [
      { source: "sessions", target: "main", weight: 182 },
      { source: "main", target: "reviewer", weight: 86 },
      { source: "main", target: "planner", weight: 74 },
      { source: "main", target: "researcher", weight: 58 },
      { source: "main", target: "verifier", weight: 47 },
      { source: "main", target: "release", weight: 29 },
      { source: "reviewer", target: "completed", weight: 80 },
      { source: "planner", target: "completed", weight: 69 },
      { source: "researcher", target: "completed", weight: 49 },
      { source: "verifier", target: "completed", weight: 43 },
      { source: "release", target: "completed", weight: 24 },
      { source: "reviewer", target: "error", weight: 4 },
      { source: "researcher", target: "error", weight: 5 },
      { source: "release", target: "error", weight: 3 },
      { source: "main", target: "compactions", weight: 74 },
    ],
    outcomes: [
      { status: "completed", count: 165 },
      { status: "error", count: 12 },
      { status: "abandoned", count: 5 },
    ],
    compactions: {
      total: 74,
      sessions: 43,
    },
  },
  toolFlow: {
    transitions: [
      { source: "Read", target: "Edit", value: 126 },
      { source: "Read", target: "Write", value: 88 },
      { source: "Grep", target: "Read", value: 76 },
      { source: "Bash", target: "Write", value: 64 },
      { source: "Edit", target: "Bash", value: 53 },
      { source: "Read", target: "Agent", value: 42 },
      { source: "Agent", target: "Read", value: 37 },
    ],
    toolCounts: [
      { toolName: "Read", count: 618 },
      { toolName: "Edit", count: 402 },
      { toolName: "Write", count: 267 },
      { toolName: "Bash", count: 249 },
      { toolName: "Grep", count: 193 },
      { toolName: "Agent", count: 102 },
    ],
  },
  effectiveness: [
    {
      subagentType: "reviewer",
      total: 86,
      completed: 80,
      errors: 4,
      sessions: 61,
      successRate: 93,
      avgDuration: 1120,
      trend: [66, 70, 74, 79, 81, 86],
    },
    {
      subagentType: "planner",
      total: 74,
      completed: 69,
      errors: 2,
      sessions: 58,
      successRate: 95,
      avgDuration: 940,
      trend: [50, 52, 57, 61, 67, 74],
    },
    {
      subagentType: "researcher",
      total: 58,
      completed: 49,
      errors: 5,
      sessions: 44,
      successRate: 84,
      avgDuration: 1840,
      trend: [22, 29, 34, 38, 46, 58],
    },
    {
      subagentType: "verifier",
      total: 47,
      completed: 43,
      errors: 2,
      sessions: 33,
      successRate: 91,
      avgDuration: 780,
      trend: [16, 22, 28, 31, 39, 47],
    },
  ],
  patterns: {
    patterns: [
      { steps: ["Read", "Edit", "Bash"], count: 41, percentage: 22.5 },
      { steps: ["Grep", "Read", "Edit"], count: 36, percentage: 19.8 },
      { steps: ["Read", "Agent", "Write"], count: 27, percentage: 14.8 },
      { steps: ["Read", "Edit", "Test"], count: 22, percentage: 12.1 },
    ],
    soloSessionCount: 38,
    soloPercentage: 20.9,
  },
  modelDelegation: {
    mainModels: [
      { model: "gpt-5.5", agentCount: 168, sessionCount: 72 },
      { model: "claude-opus-4.1", agentCount: 133, sessionCount: 58 },
      { model: "claude-sonnet-4.6", agentCount: 102, sessionCount: 37 },
      { model: "cursor-max", agentCount: 69, sessionCount: 15 },
    ],
    subagentModels: [
      { model: "gpt-5.5", agentCount: 121 },
      { model: "claude-sonnet-4.6", agentCount: 90 },
      { model: "claude-opus-4.1", agentCount: 74 },
      { model: "cursor-max", agentCount: 53 },
    ],
    tokensByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 980_000,
        outputTokens: 611_000,
        cacheReadTokens: 180_000,
        cacheWriteTokens: 72_000,
      },
      {
        model: "claude-opus-4.1",
        inputTokens: 812_000,
        outputTokens: 520_000,
        cacheReadTokens: 126_000,
        cacheWriteTokens: 61_000,
      },
      {
        model: "claude-sonnet-4.6",
        inputTokens: 643_000,
        outputTokens: 388_000,
        cacheReadTokens: 94_000,
        cacheWriteTokens: 33_000,
      },
    ],
  },
  errorPropagation: {
    byDepth: [
      { depth: 1, count: 4 },
      { depth: 2, count: 7 },
      { depth: 3, count: 11 },
      { depth: 4, count: 5 },
    ],
    byType: [
      { subagentType: "researcher", count: 8 },
      { subagentType: "reviewer", count: 6 },
      { subagentType: "release", count: 4 },
      { subagentType: "planner", count: 3 },
    ],
    eventErrors: [
      { summary: "GitHub auth expired during PR sync", count: 4 },
      { summary: "Tool timeout while running repo-wide test suite", count: 3 },
      { summary: "Sandbox rejected write outside scoped root", count: 2 },
    ],
    sessionsWithErrors: 19,
    totalSessions: 182,
    errorRate: 10.4,
  },
  concurrency: {
    aggregateLanes: [
      { name: "Main agent", avgStart: 0, avgEnd: 92, count: 182 },
      { name: "Planner", avgStart: 8, avgEnd: 39, count: 74 },
      { name: "Reviewer", avgStart: 26, avgEnd: 67, count: 86 },
      { name: "Researcher", avgStart: 18, avgEnd: 74, count: 58 },
      { name: "Verifier", avgStart: 58, avgEnd: 88, count: 47 },
    ],
  },
  complexity: [
    {
      id: "sess-1",
      name: "Design-system extraction",
      status: "active",
      duration: 4200,
      agentCount: 5,
      subagentCount: 3,
      totalTokens: 318_000,
      model: "gpt-5.5",
    },
    {
      id: "sess-2",
      name: "Desktop renderer tab normalization",
      status: "waiting",
      duration: 3000,
      agentCount: 6,
      subagentCount: 4,
      totalTokens: 284_000,
      model: "claude-opus-4.1",
    },
    {
      id: "sess-3",
      name: "Pack catalog ingestion",
      status: "completed",
      duration: 1850,
      agentCount: 4,
      subagentCount: 2,
      totalTokens: 201_000,
      model: "claude-sonnet-4.6",
    },
    {
      id: "sess-4",
      name: "PR telemetry patch",
      status: "completed",
      duration: 980,
      agentCount: 2,
      subagentCount: 1,
      totalTokens: 96_000,
      model: "gpt-5.5",
    },
    {
      id: "sess-5",
      name: "Workflow viewer port",
      status: "error",
      duration: 2700,
      agentCount: 7,
      subagentCount: 5,
      totalTokens: 356_000,
      model: "cursor-max",
    },
  ],
  compaction: {
    totalCompactions: 74,
    tokensRecovered: 412_000,
    perSession: [
      { sessionId: "sess-1", compactions: 4 },
      { sessionId: "sess-2", compactions: 3 },
      { sessionId: "sess-3", compactions: 1 },
      { sessionId: "sess-4", compactions: 0 },
      { sessionId: "sess-5", compactions: 5 },
      { sessionId: "sess-6", compactions: 2 },
      { sessionId: "sess-7", compactions: 3 },
    ],
    sessionsWithCompactions: 43,
    totalSessions: 182,
  },
  cooccurrence: [
    { source: "planner", target: "reviewer", weight: 54 },
    { source: "reviewer", target: "verifier", weight: 47 },
    { source: "planner", target: "researcher", weight: 41 },
    { source: "researcher", target: "reviewer", weight: 35 },
    { source: "release", target: "verifier", weight: 18 },
  ],
};
