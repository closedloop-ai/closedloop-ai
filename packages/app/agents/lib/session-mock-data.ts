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
  Cable,
  Cpu,
  FolderOpen,
  GitPullRequest,
  LayoutDashboard,
  Package2,
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
  EndpointConfig,
  FeatureFlag,
  ImportHistoryItem,
  Job,
  LogEntry,
  MaintenanceAction,
  NotificationPreference,
  Pack,
  PackDetail,
  PackInstallRun,
  Plan,
  PolicyOverride,
  PullRequest,
  PullRequestSession,
  RelaySettings,
  RuntimePricingDraft,
  RuntimePricingRule,
  SandboxPolicy,
  SavedConfig,
  SavedConfigStatus,
  SecurityKey,
  SecurityPosture,
  SessionOverviewStats,
  SessionRow,
  ShellRecord,
  Skill,
  SubagentDispatch,
  SystemStatusItem,
  ToolEvent,
  ToolFacet,
  WorkflowData,
  WorkflowSessionDrillIn,
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

const activityFeedRecord = {
  title: "Activity",
  description:
    "Realtime event feed decomposed from the upstream monitor into shared filters, grouped rows, and detail panels.",
  live: true,
  paused: false,
  bufferedCount: 0,
  grouped: true,
  filters: {
    query: "monitor",
    from: "2026-05-28T09:00",
    to: "2026-05-28T17:30",
    statuses: ["working", "waiting", "completed", "error"],
    eventTypes: ["PreToolUse", "PostToolUse", "SubagentStart", "Compaction"],
    toolNames: ["Read", "Edit", "Grep", "Bash", "exec_command"],
    agents: [
      { id: "agent-main", label: "Main agent" },
      { id: "agent-review", label: "reviewer" },
      { id: "agent-plan", label: "planner" },
    ],
    sessions: sessions.map((session) => ({
      id: session.id,
      label: session.name,
    })),
  },
  availableFilters: {
    statuses: ["working", "waiting", "completed", "error"],
    eventTypes: [
      "PreToolUse",
      "PostToolUse",
      "SubagentStart",
      "SubagentStop",
      "Compaction",
      "Stop",
    ],
    toolNames: ["Read", "Edit", "Grep", "Bash", "exec_command", "write_stdin"],
    agents: [
      { id: "agent-main", label: "Main agent" },
      { id: "agent-plan", label: "planner" },
      { id: "agent-review", label: "reviewer" },
      { id: "agent-verify", label: "verifier" },
    ],
    sessions: sessions.map((session) => ({
      value: session.id,
      label: session.name,
    })),
  },
  groupedEvents: [
    {
      id: "activity-group-1",
      title: "Monitor workflow extraction",
      durationLabel: "8m",
      events: [
        {
          id: "activity-event-1",
          sessionId: "sess-1",
          agentId: "agent-main",
          agentLabel: "Main agent",
          project: "symphony-alpha",
          eventType: "PreToolUse",
          status: "working",
          toolName: "Read",
          title: "Inventory monitor and desktop surfaces",
          summary:
            "Enumerated the upstream pages, renderer widgets, and settings tabs before extracting the design-system champions.",
          createdAt: "2026-05-28T15:21:00.000Z",
          metadata: [
            { label: "path", value: "agent-dashboard-client/src/pages" },
            { label: "matches", value: "15 pages" },
          ],
          detail: {
            summary: {
              headline:
                "The activity surface now points at decomposed DS components instead of the upstream embedded app.",
            },
            fields: [
              {
                key: "source_paths",
                label: "Source paths",
                value: {
                  upstream: "agent-dashboard-client/src/pages",
                  extracted: "packages/design-system/components/ui",
                },
              },
            ],
          },
        },
        {
          id: "activity-event-2",
          sessionId: "sess-1",
          agentId: "agent-plan",
          agentLabel: "planner",
          project: "closedloop-electron",
          eventType: "PostToolUse",
          status: "completed",
          toolName: "Grep",
          title: "Mapped workflow and session gaps",
          summary:
            "Identified the missing activity, analytics, and conversation/detail surfaces still owned by the upstream package.",
          createdAt: "2026-05-28T15:26:00.000Z",
          metadata: [{ label: "gap set", value: "activity + analytics" }],
          detail: {
            fields: [
              {
                key: "gap_matrix",
                label: "Gap matrix",
                value: {
                  missing: [
                    "conversation renderers",
                    "event detail views",
                    "run workspace",
                    "cc config workspace",
                  ],
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "activity-group-2",
      title: "Session detail decomposition",
      durationLabel: "11m",
      events: [
        {
          id: "activity-event-3",
          sessionId: "sess-1",
          agentId: "agent-review",
          agentLabel: "reviewer",
          project: "symphony-alpha",
          eventType: "PreToolUse",
          status: "working",
          toolName: "Edit",
          title: "Extracted agent cards and conversation rows",
          summary:
            "Rebuilt the session-detail drill-in from reusable tabs, agent cards, message blocks, and event groups.",
          createdAt: "2026-05-28T15:43:00.000Z",
          metadata: [
            {
              label: "components",
              value: "session conversation + event detail",
            },
          ],
          detail: {
            summary: {
              headline:
                "The old message card primitive has been replaced by a list-level transcript renderer that owns tool/result pairing.",
            },
            fields: [
              {
                key: "reused_primitives",
                label: "Reused primitives",
                value: [
                  "code-block",
                  "markdown-content",
                  "tool-call-block",
                  "event-detail",
                ],
              },
            ],
          },
        },
      ],
    },
  ],
  flatEvents: [
    {
      id: "activity-flat-1",
      sessionId: "sess-1",
      agentId: "agent-main",
      agentLabel: "Main agent",
      project: "symphony-alpha",
      eventType: "PreToolUse",
      status: "working",
      toolName: "Read",
      title: "Read upstream ActivityFeed.tsx",
      summary:
        "Pulled the realtime activity page into the current gap inventory.",
      createdAt: "2026-05-28T16:02:00.000Z",
      metadata: [{ label: "file", value: "ActivityFeed.tsx" }],
      detail: {
        fields: [
          {
            key: "file",
            label: "File",
            value: "agent-dashboard-client/src/pages/ActivityFeed.tsx",
          },
        ],
      },
    },
    {
      id: "activity-flat-2",
      sessionId: "sess-1",
      agentId: "agent-main",
      agentLabel: "Main agent",
      project: "symphony-alpha",
      eventType: "PostToolUse",
      status: "completed",
      toolName: "Edit",
      title: "Added shared activity workspace",
      summary:
        "Created DS-owned grouped and flat event browsing with reusable detail rows and pagination.",
      createdAt: "2026-05-28T16:09:00.000Z",
      metadata: [
        { label: "component", value: "activity feed + event filters" },
      ],
      detail: {
        fields: [
          {
            key: "component",
            label: "Component",
            value: "activity feed + event filters",
          },
        ],
      },
    },
  ],
  pagination: {
    page: 0,
    pageSize: 50,
    total: 184,
    totalPages: 4,
  },
};

export const activityFeedFilters = activityFeedRecord.filters;
export const activityFeedFacets = activityFeedRecord.availableFilters;
export const activityFeedEvents = activityFeedRecord.flatEvents;

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

export const shellRecord: ShellRecord = {
  title: "Agent Monitor",
  productLabel: "Closedloop Gateway",
  collapsed: false,
  embedded: false,
  navItems: [
    {
      id: "dashboard",
      label: "Dashboard",
      href: "/",
      icon: LayoutDashboard,
      active: true,
    },
    {
      id: "sessions",
      label: "Sessions",
      href: "/sessions",
      icon: FolderOpen,
      badge: 48,
    },
    {
      id: "activity",
      label: "Activity Feed",
      href: "/activity",
      icon: Activity,
      badge: 12,
    },
    { id: "workflows", label: "Workflows", href: "/workflows", icon: Workflow },
    { id: "packs", label: "Packs", href: "/packs", icon: Package2, badge: 7 },
    {
      id: "pull-requests",
      label: "Pull Requests",
      href: "/pull-requests",
      icon: GitPullRequest,
      badge: 18,
    },
    { id: "settings", label: "Settings", href: "/settings", icon: ShieldCheck },
  ],
  connection: {
    connected: true,
    connectedSince: "2026-05-29 08:14",
    eventCount: 8241,
    peakPerSecond: 49,
    lastEvent: {
      type: "session.updated",
      at: "14 seconds ago",
    },
    recentEvents: [
      { type: "session.updated", at: "14 seconds ago" },
      { type: "activity.appended", at: "28 seconds ago" },
      { type: "run.spawned", at: "1 minute ago" },
    ],
  },
  update: {
    state: "available",
    label: "Desktop update ready",
    detail: "2 new fixes for pack installs and Run routing.",
  },
  languages: [
    { code: "en", label: "English", active: true },
    { code: "fr", label: "French" },
    { code: "es", label: "Spanish" },
  ],
};

export const runtimePricingDraft: RuntimePricingDraft = {
  modelPattern: "gpt-5.5*",
  displayName: "GPT-5.5",
  inputPerMillion: 4,
  outputPerMillion: 16,
  cacheReadPerMillion: 0.4,
  cacheWritePerMillion: 5,
};

export const runtimePricingRules: RuntimePricingRule[] = [
  {
    id: "pricing-1",
    modelPattern: "gpt-5.5*",
    displayName: "GPT-5.5",
    inputPerMillion: 4,
    outputPerMillion: 16,
    cacheReadPerMillion: 0.4,
    cacheWritePerMillion: 5,
    updatedAt: "2026-05-29T13:10:00.000Z",
  },
  {
    id: "pricing-2",
    modelPattern: "claude-opus-4.1*",
    displayName: "Claude Opus 4.1",
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
    updatedAt: "2026-05-28T17:00:00.000Z",
  },
  {
    id: "pricing-3",
    modelPattern: "cursor-max",
    displayName: "Cursor Max",
    inputPerMillion: 6,
    outputPerMillion: 24,
    cacheReadPerMillion: 0.6,
    cacheWritePerMillion: 7.5,
    updatedAt: "2026-05-27T11:24:00.000Z",
  },
];

export const runtimeNotifications: NotificationPreference[] = [
  {
    id: "notif-new-session",
    label: "New sessions",
    description: "Notify when a new tracked session starts.",
    enabled: true,
  },
  {
    id: "notif-session-error",
    label: "Session errors",
    description: "Raise a desktop alert when a session exits in error.",
    enabled: true,
  },
  {
    id: "notif-session-complete",
    label: "Completed sessions",
    description: "Notify when long-running sessions complete.",
    enabled: false,
  },
  {
    id: "notif-subagent",
    label: "Subagent spawns",
    description: "Notify when a session fans out into review or plan agents.",
    enabled: false,
  },
];

export const runtimeSystemStatus: SystemStatusItem[] = [
  {
    label: "Gateway relay",
    value: "Healthy",
    detail: "Connected to desktop bridge with 49 peak events/sec.",
    icon: Cable,
    tone: "success",
  },
  {
    label: "Hooks",
    value: "Installed",
    detail: "Claude hooks are active in 3 tracked repos.",
    icon: ShieldCheck,
    tone: "success",
  },
  {
    label: "Database",
    value: "182 sessions",
    detail: "SQLite store compacted 24 minutes ago.",
    icon: Cpu,
    tone: "info",
  },
  {
    label: "Packs catalog",
    value: "Stale cache",
    detail: "Catalog refresh recommended before next install.",
    icon: Package2,
    tone: "warning",
  },
];

export const runtimeMaintenanceActions: MaintenanceAction[] = [
  {
    id: "refresh-catalog",
    label: "Refresh pack catalog",
    description: "Sync the latest pack metadata and screenshots.",
    buttonLabel: "Refresh",
  },
  {
    id: "reinstall-hooks",
    label: "Reinstall hooks",
    description: "Repair Claude hook symlinks and runtime scripts.",
    buttonLabel: "Reinstall",
  },
  {
    id: "rebuild-search",
    label: "Rebuild activity index",
    description: "Recreate the local search index for activity and sessions.",
    buttonLabel: "Rebuild",
  },
  {
    id: "reset-store",
    label: "Reset local store",
    description: "Clear imported monitor data and reset local caches.",
    buttonLabel: "Reset",
    danger: true,
  },
];

export const runtimeImportHistory: ImportHistoryItem[] = [
  {
    id: "import-1",
    filename: "desktop-replay-2026-05-28.ndjson",
    importedAt: "2026-05-28T21:18:00.000Z",
    sessions: 42,
    events: 1964,
    status: "complete",
  },
  {
    id: "import-2",
    filename: "workflow-sample-2026-05-27.ndjson",
    importedAt: "2026-05-27T18:09:00.000Z",
    sessions: 18,
    events: 734,
    status: "partial",
  },
];

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

export const settingsMetrics: Metric[] = [
  {
    label: "Gateway port",
    value: 4318,
    detail: "Loopback-only",
    icon: Cable,
  },
  {
    label: "Cloud connection",
    value: "Connected",
    detail: "Relay heartbeat healthy",
    icon: Workflow,
  },
  {
    label: "Security",
    value: "Strict",
    detail: "Mutual TLS enforced",
    icon: ShieldCheck,
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

export const securityKeys: SecurityKey[] = [
  {
    id: "key-1",
    ownerName: "Avery Carter",
    ownerEmail: "avery@closedloop.ai",
    fingerprint: "1A2B3C4D5E6F778899AABBCCDDEEFF11",
    state: "authorized",
  },
  {
    id: "key-2",
    ownerName: "Jordan Lee",
    ownerEmail: "jordan@closedloop.ai",
    fingerprint: "FFEEDDCCBBAA99887766554433221100",
    state: "pending",
  },
];

export const featureFlags: FeatureFlag[] = [
  {
    id: "plan-extraction",
    label: "Plan extraction",
    description:
      "Captures implementation plans from Claude Code and Codex sessions.",
    source: "user",
    enabled: true,
  },
  {
    id: "desktop-heartbeat-revival",
    label: "Desktop heartbeat revival",
    description:
      "Restores relay heartbeats with desktop-managed proof-of-possession auth.",
    source: "env",
    enabled: true,
  },
  {
    id: "legacy-engineer-routes",
    label: "Legacy engineer routes",
    description: "Keeps the deprecated namespace disabled in current builds.",
    source: "default",
    enabled: false,
  },
];

export const savedConfigs: SavedConfig[] = [
  { id: "cfg-1", name: "Production relay", hasApiKey: true, active: true },
  { id: "cfg-2", name: "Preview sandbox", hasApiKey: false },
  { id: "cfg-3", name: "Local API debug", hasApiKey: true },
];

export const savedConfigStatus: SavedConfigStatus = {
  tone: "success",
  message: "Switched to Production relay and reloaded gateway settings.",
};

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

export const toolFacets: ToolFacet[] = [
  {
    id: "Read",
    name: "Read",
    count: 412,
    lastSeen: "2026-05-28T15:21:00.000Z",
  },
  {
    id: "Edit",
    name: "Edit",
    count: 174,
    lastSeen: "2026-05-28T15:18:00.000Z",
  },
  { id: "Bash", name: "Bash", count: 91, lastSeen: "2026-05-28T15:12:00.000Z" },
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

export const subagentDispatches: SubagentDispatch[] = [
  {
    id: "dispatch-1",
    name: "Schema verifier",
    type: "schema-check",
    status: "completed",
    task: "Validate desktop telemetry schema compatibility in symphony-alpha.",
    sessionId: "sess-3",
    startedAt: "2026-05-28T11:20:00.000Z",
    endedAt: "2026-05-28T11:24:00.000Z",
  },
  {
    id: "dispatch-2",
    name: "Pack catalog diff",
    type: "catalog-audit",
    status: "running",
    task: "Inspect marketplace metadata and reconcile pack badges.",
    sessionId: "sess-4",
    startedAt: "2026-05-28T15:03:00.000Z",
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

export const pullRequestSessions: PullRequestSession[] = [
  {
    id: "sess-1",
    sessionName: "Design-system extraction",
    startedAt: "2026-05-28T09:10:00.000Z",
    cwd: "/workspace/symphony-alpha",
    harness: "codex",
    pullRequests: [pullRequests[0]!],
  },
  {
    id: "sess-5",
    sessionName: "Agent monitor wiring patch",
    startedAt: "2026-05-27T18:20:00.000Z",
    cwd: "/workspace/closedloop-electron",
    harness: "claude",
    pullRequests: [pullRequests[1]!],
  },
  {
    id: "sess-6",
    sessionName: "PR composition convergence",
    startedAt: "2026-05-28T15:41:00.000Z",
    cwd: "/workspace/symphony-alpha",
    harness: "codex",
    pullRequests: [pullRequests[0]!, pullRequests[2]!],
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

export const relayEndpoints: EndpointConfig[] = [
  { label: "Target ID", value: "desktop-prod-us-01" },
  { label: "Relay Origin", value: "wss://relay.closedloop.ai/gateway" },
  { label: "API Origin", value: "https://api.closedloop.ai" },
  { label: "Web App Origin", value: "https://app.closedloop.ai" },
];

export const relaySettings: RelaySettings = {
  targetId: "desktop-prod-us-01",
  relayOrigin: "wss://relay.closedloop.ai/gateway",
  apiOrigin: "https://api.closedloop.ai",
  webAppOrigin: "https://app.closedloop.ai",
  apiKeyStatus: "Cloud API key: stored in secure keychain",
  debugTokenStatus: "Dev auth token idle",
  metrics: settingsMetrics,
  endpoints: relayEndpoints,
};

export const policyOverrides: PolicyOverride[] = [
  { operationId: "deploy", tier: "medium" },
  { operationId: "git_pr", tier: "low" },
  { operationId: "filesystem", tier: "none" },
];

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

export const securityPosture: SecurityPosture[] = [
  {
    id: "sandbox",
    label: "Sandbox",
    value: "Locked",
    detail: "Scoped to workspace root",
    tone: "success",
  },
  {
    id: "signing",
    label: "Signing Keys",
    value: "1 pending",
    detail: "1 authorized, 1 awaiting approval.",
    tone: "warning",
  },
  {
    id: "denylist",
    label: "Always Denied",
    value: "7 paths",
    detail: "Built-in protections override the sandbox.",
    tone: "danger",
  },
];

export const sandboxPolicy: SandboxPolicy = {
  allowedRoot: "/workspace",
  warning:
    "Warning: this sandbox is broad or sensitive. Choose a tighter directory such as ~/Source.",
  deniedPaths: [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/Library/Keychains",
    "/etc",
    "/bin",
    "/sbin",
  ],
};

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

const sessionDetailRecord = {
  session: {
    ...sessions[0],
    cwd: "/workspace/symphony-alpha",
    summary:
      "Session detail decomposition for the upstream embedded monitor, using shared DS tabs, badges, cards, and timeline rows.",
  },
  overview: sessionOverviewStats,
  activeAgentId: "agent-main",
  activeTranscriptId: "transcript-main",
  agents: [
    {
      id: "agent-main",
      sessionId: "sess-1",
      name: "Main agent",
      type: "main",
      status: "working",
      task: "Port remaining upstream session and activity surfaces into reusable DS composites.",
      currentTool: "Edit",
      startedAt: "2026-05-28T09:10:00.000Z",
      updatedAt: "2026-05-28T15:21:00.000Z",
      model: "gpt-5.5",
      cost: 18.94,
      label: "gpt-5.5 · symphony-alpha",
      children: [
        {
          id: "agent-plan",
          sessionId: "sess-1",
          name: "planner",
          type: "subagent",
          subagentType: "planner",
          status: "completed",
          task: "Mapped the upstream workflow and session pages into DS-ready blocks.",
          currentTool: "Grep",
          startedAt: "2026-05-28T09:12:00.000Z",
          updatedAt: "2026-05-28T09:20:00.000Z",
          endedAt: "2026-05-28T09:20:00.000Z",
          label: "planner",
        },
        {
          id: "agent-review",
          sessionId: "sess-1",
          name: "reviewer",
          type: "subagent",
          subagentType: "reviewer",
          status: "working",
          task: "Comparing each session drill-in widget against landed DS champions.",
          currentTool: "Read",
          startedAt: "2026-05-28T09:34:00.000Z",
          updatedAt: "2026-05-28T15:14:00.000Z",
          label: "reviewer",
          children: [
            {
              id: "agent-verify",
              sessionId: "sess-1",
              name: "verifier",
              type: "subagent",
              subagentType: "verifier",
              status: "waiting",
              task: "Waiting on another typecheck pass after the next session-detail patch.",
              currentTool: "pnpm exec tsc",
              startedAt: "2026-05-28T10:02:00.000Z",
              updatedAt: "2026-05-28T15:09:00.000Z",
              label: "verifier",
            },
          ],
        },
      ],
    },
  ],
  eventFacets: {
    statuses: ["working", "waiting", "completed", "error"],
    eventTypes: ["PreToolUse", "PostToolUse", "SubagentStart", "Compaction"],
    toolNames: ["Read", "Edit", "Grep", "Bash"],
    agents: [
      { id: "agent-main", label: "Main agent" },
      { id: "agent-plan", label: "planner" },
      { id: "agent-review", label: "reviewer" },
      { id: "agent-verify", label: "verifier" },
    ],
  },
  activeEventFilters: {
    query: "subagent",
    from: "2026-05-28T09:00",
    to: "2026-05-28T16:00",
    statuses: ["working", "waiting"],
    eventTypes: ["PreToolUse", "PostToolUse", "SubagentStart"],
    toolNames: ["Read", "Edit"],
    agents: [
      { id: "agent-main", label: "Main agent" },
      { id: "agent-review", label: "reviewer" },
    ],
  },
  eventGroups: [
    {
      id: "group-1",
      title: "Session bootstrap and inventory",
      durationLabel: "6m",
      events: [
        {
          id: "event-1",
          sessionId: "sess-1",
          agentId: "agent-main",
          agentLabel: "Main agent",
          eventType: "PreToolUse",
          status: "working",
          title: "Read monitor and DS file tree",
          summary:
            "The main agent enumerated both repositories to identify overlap and contention points.",
          toolName: "Read",
          project: "symphony-alpha",
          createdAt: "2026-05-28T09:11:00.000Z",
          metadata: [
            { label: "cwd", value: "~/projects/symphony-alpha" },
            { label: "result", value: "54 files" },
          ],
          detail: {
            summary: {
              headline:
                "The first pass compared the upstream monitor package against the existing design-system champions.",
              bullets: [
                "Verified overlapping tabs, cards, progress bars, and chart treatments.",
                "Flagged the conversation and activity renderers as still upstream-owned.",
              ],
            },
            fields: [
              {
                key: "tool_input",
                label: "Tool input",
                value: {
                  file_path: "packages/design-system/components/ui",
                  limit: 54,
                  offset: 0,
                },
              },
              {
                key: "tool_response",
                label: "Tool response",
                value:
                  "ui/data-visualization/workflows\nui/documents-conversation/session-detail\nui/primitives/status-badge",
              },
            ],
          },
        },
        {
          id: "event-2",
          sessionId: "sess-1",
          agentId: "agent-plan",
          agentLabel: "planner",
          eventType: "PostToolUse",
          status: "completed",
          title: "Cataloged upstream page surfaces",
          summary:
            "Workflows, Sessions, Activity, Settings, Packs, PRs, and Kanban were mapped into a gap matrix.",
          toolName: "Grep",
          project: "closedloop-electron",
          createdAt: "2026-05-28T09:17:00.000Z",
          metadata: [{ label: "pages", value: "15" }],
          detail: {
            fields: [
              {
                key: "page_matrix",
                label: "Page matrix",
                value: {
                  embedded: [
                    "Dashboard",
                    "Sessions",
                    "ActivityFeed",
                    "Analytics",
                    "Workflows",
                    "Settings",
                    "CcConfig",
                    "Run",
                  ],
                  native: [
                    "ImportHistory",
                    "Desktop settings",
                    "Gateway relay",
                  ],
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "group-2",
      title: "Session-detail extraction",
      durationLabel: "14m",
      events: [
        {
          id: "event-3",
          sessionId: "sess-1",
          agentId: "agent-review",
          agentLabel: "reviewer",
          eventType: "PreToolUse",
          status: "working",
          title: "Compared session-detail widgets against DS champions",
          summary:
            "Agent cards, timeline rows, and tabs were decomposed so the page no longer owns those patterns.",
          toolName: "Read",
          project: "symphony-alpha",
          createdAt: "2026-05-28T09:43:00.000Z",
          metadata: [{ label: "components", value: "7 extracted" }],
          detail: {
            summary: {
              headline:
                "Session detail is now built from the shared overview, tabs, agent cards, and timeline pieces.",
            },
            fields: [
              {
                key: "extracted_components",
                label: "Extracted components",
                value: [
                  "session-overview",
                  "session-agents-panel",
                  "session-timeline-panel",
                  "message-list",
                ],
              },
            ],
          },
        },
        {
          id: "event-4",
          sessionId: "sess-1",
          agentId: "agent-main",
          agentLabel: "Main agent",
          eventType: "Compaction",
          status: "waiting",
          title: "Compacted context into the next porting backlog",
          summary:
            "The current pass queued Activity, Analytics, Run, and conversation/event renderers for the next commits.",
          project: "symphony-alpha",
          createdAt: "2026-05-28T10:05:00.000Z",
          metadata: [{ label: "next", value: "Activity + Analytics" }],
        },
      ],
    },
  ],
  transcripts: [
    {
      id: "transcript-main",
      label: "Main agent conversation",
      agentId: "agent-main",
      agentLabel: "Main agent",
      status: "working",
      totalMessages: 94,
      hasMoreHistory: true,
      refreshing: true,
      messages: [
        {
          id: "msg-1",
          role: "user",
          author: "Mike",
          createdAt: "2026-05-28T09:10:00.000Z",
          content:
            "Exhaustively decompose every upstream monitor page into canonical design-system primitives, composites, and layouts.",
          blocks: [
            {
              type: "text",
              text: "Exhaustively decompose every upstream monitor page into canonical design-system primitives, composites, and layouts.",
            },
          ],
        },
        {
          id: "msg-2",
          role: "assistant",
          author: "Codex",
          createdAt: "2026-05-28T09:11:00.000Z",
          content:
            "I’m starting with an inventory of Sessions, Activity, Workflows, Settings, Packs, Pull Requests, and Kanban to identify the shared champions and the missing extractions.",
          model: "gpt-5.5",
          usage: {
            inputTokens: 1204,
            outputTokens: 286,
          },
          blocks: [
            {
              type: "thinking",
              text: "I need to inventory every embedded page first, then map overlapping controls onto existing design-system champions before extracting anything page-specific.",
            },
            {
              type: "text",
              text: "I’m starting with an inventory of Sessions, Activity, Workflows, Settings, Packs, Pull Requests, and Kanban to identify the shared champions and the missing extractions.",
            },
          ],
        },
        {
          id: "msg-3",
          role: "assistant",
          author: "Codex",
          toolName: "Read",
          createdAt: "2026-05-28T09:12:00.000Z",
          content:
            "rg --files node_modules/.pnpm/agent-dashboard-client@*/node_modules/agent-dashboard-client/src/pages",
          blocks: [
            {
              type: "tool_use",
              id: "tool-use-pages",
              name: "Read",
              input: {
                file_path:
                  "node_modules/.pnpm/agent-dashboard-client/node_modules/agent-dashboard-client/src/pages",
                offset: 0,
                limit: 200,
              },
            },
            {
              type: "tool_result",
              id: "tool-use-pages",
              output:
                "Dashboard.tsx\nSessions.tsx\nSessionDetail.tsx\nActivityFeed.tsx\nAnalytics.tsx\nWorkflows.tsx\nSettings.tsx\nCcConfig.tsx\nRun.tsx",
            },
          ],
        },
        {
          id: "msg-4",
          role: "assistant",
          author: "Codex",
          createdAt: "2026-05-28T09:16:00.000Z",
          content:
            "Workflows is now decomposed; next I’m extracting the session-detail drill-in so those cards, timeline rows, and tabs become reusable.",
          blocks: [
            {
              type: "text",
              text: "Workflows is now decomposed; next I’m extracting the session-detail drill-in so those cards, timeline rows, and tabs become reusable.\n\n<command-name>pnpm</command-name><command-args>-C apps/storybook build</command-args>\n<local-command-stdout>storybook build completed successfully</local-command-stdout>",
            },
          ],
        },
      ],
    },
    {
      id: "transcript-reviewer",
      label: "Reviewer transcript",
      agentId: "agent-review",
      agentLabel: "reviewer",
      status: "working",
      totalMessages: 21,
      newMessagesAvailable: true,
      messages: [
        {
          id: "msg-5",
          role: "assistant",
          author: "reviewer",
          createdAt: "2026-05-28T09:45:00.000Z",
          content:
            "The settings page and session drill-in were both carrying their own tab styling. I extracted one monitor tab primitive on top of the DS tabs champion.",
          blocks: [
            {
              type: "text",
              text: "The settings page and session drill-in were both carrying their own tab styling. I extracted one monitor tab primitive on top of the DS tabs champion.",
            },
          ],
        },
      ],
    },
  ],
};

export const sessionConversationTranscript =
  sessionDetailRecord.transcripts[0]!;
export const sessionEventFacets = sessionDetailRecord.eventFacets;
export const sessionEventFilters = sessionDetailRecord.activeEventFilters || {
  query: "",
  statuses: [],
  eventTypes: [],
  toolNames: [],
  agents: [],
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

export const workflowSessionDrillIn: WorkflowSessionDrillIn = {
  session: {
    id: "sess-1",
    name: "Design-system extraction",
    status: "active",
    cwd: "/workspace/symphony-alpha",
    model: "gpt-5.5",
    startedAt: "2026-05-28T09:10:00.000Z",
    endedAt: null,
  },
  tree: [
    {
      id: "agent-main",
      name: "Main agent",
      type: "main",
      subagentType: null,
      status: "working",
      task: "Normalize embedded monitor widgets into shared DS composites",
      startedAt: "2026-05-28T09:10:00.000Z",
      endedAt: null,
      children: [
        {
          id: "agent-plan",
          name: "planner",
          type: "subagent",
          subagentType: "planner",
          status: "completed",
          task: "Map upstream pages to DS primitives/composites/layout",
          startedAt: "2026-05-28T09:12:00.000Z",
          endedAt: "2026-05-28T09:20:00.000Z",
          children: [],
        },
        {
          id: "agent-review",
          name: "reviewer",
          type: "subagent",
          subagentType: "reviewer",
          status: "working",
          task: "Validate shared champions against current main",
          startedAt: "2026-05-28T09:34:00.000Z",
          endedAt: null,
          children: [
            {
              id: "agent-verify",
              name: "verifier",
              type: "subagent",
              subagentType: "verifier",
              status: "working",
              task: "Check Storybook parity for workflow visualizations",
              startedAt: "2026-05-28T10:02:00.000Z",
              endedAt: null,
              children: [],
            },
          ],
        },
      ],
    },
  ],
  toolTimeline: [
    {
      id: 1,
      toolName: "Read",
      eventType: "tool_use",
      agentId: "agent-main",
      createdAt: "2026-05-28T09:11:00.000Z",
      summary: "Scanned current DS component tree",
    },
    {
      id: 2,
      toolName: "Grep",
      eventType: "tool_use",
      agentId: "agent-plan",
      createdAt: "2026-05-28T09:14:00.000Z",
      summary: "Mapped upstream workflow files and route surfaces",
    },
    {
      id: 3,
      toolName: "Edit",
      eventType: "tool_use",
      agentId: "agent-main",
      createdAt: "2026-05-28T09:26:00.000Z",
      summary: "Added monitor workflow data contracts",
    },
    {
      id: 4,
      toolName: "Bash",
      eventType: "tool_use",
      agentId: "agent-review",
      createdAt: "2026-05-28T09:48:00.000Z",
      summary: "Ran local typecheck against design-system package",
    },
  ],
  swimLanes: [
    {
      id: "agent-main",
      name: "Main agent",
      type: "main",
      subagentType: null,
      status: "working",
      startedAt: "2026-05-28T09:10:00.000Z",
      endedAt: null,
      parentAgentId: null,
    },
    {
      id: "agent-plan",
      name: "planner",
      type: "subagent",
      subagentType: "planner",
      status: "completed",
      startedAt: "2026-05-28T09:12:00.000Z",
      endedAt: "2026-05-28T09:20:00.000Z",
      parentAgentId: "agent-main",
    },
    {
      id: "agent-review",
      name: "reviewer",
      type: "subagent",
      subagentType: "reviewer",
      status: "working",
      startedAt: "2026-05-28T09:34:00.000Z",
      endedAt: null,
      parentAgentId: "agent-main",
    },
    {
      id: "agent-verify",
      name: "verifier",
      type: "subagent",
      subagentType: "verifier",
      status: "working",
      startedAt: "2026-05-28T10:02:00.000Z",
      endedAt: null,
      parentAgentId: "agent-review",
    },
  ],
  events: [
    {
      id: 11,
      sessionId: "sess-1",
      agentId: "agent-main",
      eventType: "agent_start",
      toolName: null,
      summary: "Main agent session booted",
      createdAt: "2026-05-28T09:10:00.000Z",
    },
    {
      id: 12,
      sessionId: "sess-1",
      agentId: "agent-plan",
      eventType: "tool_use",
      toolName: "Grep",
      summary: "Enumerated embedded monitor workflow components",
      createdAt: "2026-05-28T09:14:00.000Z",
    },
    {
      id: 13,
      sessionId: "sess-1",
      agentId: "agent-review",
      eventType: "tool_use",
      toolName: "Read",
      summary: "Compared landed DS tabs and badge champions",
      createdAt: "2026-05-28T09:41:00.000Z",
    },
    {
      id: 14,
      sessionId: "sess-1",
      agentId: "agent-main",
      eventType: "compaction",
      toolName: null,
      summary: "Compacted workflow notes into DS port backlog",
      createdAt: "2026-05-28T10:05:00.000Z",
    },
  ],
};
