// Renderer-facing agent-database IPC contract.
//
// These are the response DTOs returned by the `desktop:db:*` IPC handlers and
// consumed by the first-party renderer (`src/renderer/`). They are the stable
// shared contract between main and renderer — the renderer MUST import its DB
// response shapes from here, NOT from `src/main/database/types.ts`.
//
// Raw persistence rows are private to `src/main/database/`. Each repository
// store maps those raw rows into the DTOs below, so a schema/column change is
// absorbed at that boundary and does not break the renderer's compile-time
// contract. Purely-internal row types that never cross IPC stay in main.

export type SessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  awaitingInputSince: string | null;
  metadata: string | null;
  harness: string | null;
  billingMode: string | null;
  userId: string | null;
  organizationId: string | null;
};

export type AgentRow = {
  id: string;
  sessionId: string;
  name: string | null;
  type: string | null;
  subagentType: string | null;
  status: string;
  task: string | null;
  currentTool: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  awaitingInputSince: string | null;
  parentAgentId: string | null;
  metadata: string | null;
};

export type EventRow = {
  id: string;
  sessionId: string;
  agentId: string | null;
  eventType: string;
  toolName: string | null;
  summary: string | null;
  data: string | null;
  createdAt: string | null;
};

export type DashboardSummary = {
  totalSessions: number;
  activeSessions: number;
  totalAgents: number;
  totalEvents: number;
  eventTypeCount: number;
  totalTokens: number;
  recentSessions: Array<{
    id: string;
    name: string | null;
    status: string;
    model: string | null;
    cwd: string | null;
    startedAt: string | null;
  }>;
};

export interface SessionWithAgents extends SessionRow {
  agentCount: number;
  eventCount: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export type SessionPageRequest = {
  limit?: number;
  offset?: number;
  status?: string;
  q?: string;
};

export type SessionPage = {
  sessions: SessionWithAgents[];
  total: number;
  limit: number;
  offset: number;
};

export type KanbanPages = Record<string, SessionPage>;

export interface EventWithSession extends EventRow {
  sessionName: string | null;
}

export type TokenAnalytics = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    sessions: number;
    estimatedCostUsd?: number;
  }>;
  byDay: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
  }>;
};

export type EventCountByType = {
  eventType: string;
  count: number;
};

export type ToolUsageItem = {
  toolName: string;
  count: number;
};

export type DailyEventCount = {
  date: string;
  count: number;
};

export type StatusCount = {
  status: string;
  count: number;
};

export type AgentTypeCount = {
  type: string;
  count: number;
};

export type AnalyticsData = {
  tokens: TokenAnalytics;
  eventsByType: EventCountByType[];
  toolUsage: ToolUsageItem[];
  dailyEvents: DailyEventCount[];
  sessionsByStatus: StatusCount[];
  agentsByStatus: StatusCount[];
  agentsByType: AgentTypeCount[];
  totalSessions: number;
  totalAgents: number;
  totalEvents: number;
};

export type WorkflowQueryData = {
  stats: {
    totalSessions: number;
    totalAgents: number;
    totalSubagents: number;
    avgSubagents: number;
    successRate: number;
    avgDepth: number;
    avgDurationSec: number;
    totalCompactions: number;
    avgCompactions: number;
    topFlow: { source: string; target: string; count: number } | null;
  };
  orchestration: {
    sessionCount: number;
    mainCount: number;
    subagentTypes: Array<{
      subagentType: string;
      count: number;
      completed: number;
      errors: number;
    }>;
    edges: Array<{ source: string; target: string; weight: number }>;
    outcomes: Array<{ status: string; count: number }>;
    compactions: { total: number; sessions: number };
  };
  toolFlow: {
    transitions: Array<{ source: string; target: string; value: number }>;
    toolCounts: Array<{ toolName: string; count: number }>;
  };
  effectiveness: Array<{
    subagentType: string;
    total: number;
    completed: number;
    errors: number;
    sessions: number;
    successRate: number;
    avgDuration: number | null;
    trend: number[];
  }>;
  cooccurrence: Array<{ source: string; target: string; weight: number }>;
};

export type AgentHierarchyNode = {
  agentId: string;
  name: string | null;
  type: string | null;
  subagentType: string | null;
  status: string;
  task: string | null;
  currentTool: string | null;
  children: AgentHierarchyNode[];
  events: Array<{
    eventType: string;
    toolName: string | null;
    summary: string | null;
    createdAt: string | null;
  }>;
};

export type DashboardPackSummary = {
  id: string;
  name: string;
  harness: string;
  installPath: string | null;
  sourceUrl: string | null;
  version: string | null;
  skillCount: number;
  toolCallCount: number;
  lastUsedAt: string | null;
};

export type DashboardSkillSummary = {
  id: string;
  packId: string | null;
  name: string;
  harness: string;
  description: string | null;
  installPath: string | null;
  invocationCount: number;
  lastUsedAt: string | null;
};

export type DashboardToolSummary = {
  toolName: string;
  invocationCount: number;
  sessionCount: number;
  lastUsedAt: string | null;
};

export type DashboardSubAgentSummary = {
  subagentType: string;
  total: number;
  completed: number;
  errors: number;
  sessions: number;
  lastUsedAt: string | null;
};

export type DashboardPlanSummary = {
  id: string;
  sessionId: string | null;
  title: string;
  source: string | null;
  content: string;
  timestamp: string | null;
  harness: string | null;
  cwd: string | null;
};

export type DashboardPullRequestSummary = {
  id: string;
  sessionId: string | null;
  sessionName: string | null;
  prUrl: string;
  prNumber: number;
  repoFullName: string;
  branchName: string | null;
  headSha: string | null;
  title: string | null;
  harness: string | null;
  observedAt: string | null;
};

export type DashboardCoreFeatures = {
  packs: DashboardPackSummary[];
  skills: DashboardSkillSummary[];
  tools: DashboardToolSummary[];
  subagents: DashboardSubAgentSummary[];
  plans: DashboardPlanSummary[];
  pullRequests: DashboardPullRequestSummary[];
};

// --- Catalog (FEA-1314) ---

export type CatalogEntry = {
  packId: string;
  displayName: string;
  category: string | null;
  githubUrl: string;
  marketplaceUrl: string | null;
  description: string | null;
  descriptionLive: string | null;
  harnesses: string[];
  installCommands: Record<string, string> | null;
  uninstallCommands: Record<string, string> | null;
  installNotes: string | null;
  placeholderReason: string | null;
  verified: boolean;
  readmeExcerpt: string | null;
  stars: number | null;
  forks: number | null;
  lastRelease: string | null;
  seedVersion: number;
  pinOrder: number | null;
  contents: CatalogContentsConfig | null;
  contentsCache: CatalogContentItem[] | null;
  detectionPatterns: string[] | null;
  harnessAgnostic: boolean;
  projectScoped: boolean;
  singleInstall: boolean;
  postInstall: Record<string, unknown> | null;
  // Joined from agent_packs
  installedHarnesses: string[];
  skillCount: number;
  usageCount: number;
  // Sparkline data
  history: Array<{ fetchedAt: string; stars: number; forks: number }>;
};

export type CatalogContentsConfig = {
  type: string;
  [key: string]: unknown;
};

export type CatalogContentItem = {
  name: string;
  type: string;
  description?: string;
  path?: string;
};

export type InstallRunRecord = {
  id: number;
  packId: string;
  harness: string | null;
  action: string;
  command: string | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  stdoutTail: string | null;
  stderrTail: string | null;
};

export type CatalogMutationResult = {
  started: boolean;
  runId?: number;
  error?: {
    code: string;
    message: string;
  };
};

export type InstallOutputChunk = {
  runId: number;
  type:
    | "start"
    | "stdout"
    | "stderr"
    | "error"
    | "post_install"
    | "copy_command"
    | "complete";
  data: unknown;
};

// --- Installed Packs (FEA-1224) ---

export type InstalledPack = {
  packId: string;
  harnesses: string[];
  installs: Array<{
    harness: string;
    installPath: string;
    installKind: string | null;
    sourceUrl: string | null;
    version: string | null;
    detectedAt: string | null;
    lastSeenAt: string | null;
  }>;
  skillCount: number;
  lastSeenAt: string | null;
};

export interface InstalledPackDetail extends InstalledPack {
  skills: Array<{
    skillId: string;
    name: string | null;
    version: string | null;
    description: string | null;
    harness: string | null;
  }>;
  associations: Array<{
    projectPath: string;
    detectedAt: string | null;
    lastSeenAt: string | null;
  }>;
}

export type SkillWithInvocations = {
  skillId: string;
  packId: string | null;
  name: string;
  harness: string | null;
  description: string | null;
  invocationCount: number;
  lastUsedAt: string | null;
};

export type SkillInvocation = {
  eventId: string;
  sessionId: string;
  sessionName: string | null;
  harness: string | null;
  model: string | null;
  createdAt: string | null;
};

// --- Plans (FEA-1189) ---

export type PlanRecord = {
  id: string;
  title: string | null;
  status: string;
  source: string | null;
  captureMethod: string | null;
  harness: string | null;
  sessionId: string | null;
  filePath: string | null;
  sourceLogPath: string | null;
  needsConfirmation: boolean;
  confidence: number;
  createdAt: string | null;
  updatedAt: string | null;
  latestContent: string | null;
  versionCount: number;
};

export type PlanVersionRecord = {
  id: string;
  planId: string;
  versionNumber: number;
  contentMarkdown: string | null;
  contentSha256: string | null;
  authorType: string | null;
  captureMethod: string | null;
  createdAt: string | null;
};

// --- Pull Requests (FEA-1226) ---

export type PrRecord = {
  id: string;
  sessionId: string | null;
  prUrl: string;
  prNumber: number | null;
  repoFullName: string | null;
  branchName: string | null;
  headSha: string | null;
  title: string | null;
  harness: string | null;
  observedAt: string | null;
  createdAt: string | null;
};

export type PrStats = {
  totalPrs: number;
  sessionsWithPrs: number;
  repos: number;
};

export type PrSessionGroup = {
  sessionId: string;
  sessionName: string | null;
  cwd: string | null;
  harness: string | null;
  startedAt: string | null;
  prs: PrRecord[];
};
