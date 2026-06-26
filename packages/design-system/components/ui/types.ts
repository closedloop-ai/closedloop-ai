import {
  SESSION_STATUS,
  type SessionStatus,
} from "@closedloop-ai/loops-api/session-status";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Canonical session-status set lives in @closedloop-ai/loops-api/session-status
// (FEA-1718) — re-exported here so design-system's public type surface and the
// status badge keep their existing import path. SSOT: no local mirror.
export { SESSION_STATUS };
export type { SessionStatus };

export type Harness =
  | "claude"
  | "codex"
  | "cursor"
  | "copilot"
  | "opencode"
  | (string & {});

export const AGENT_STATUS = {
  WORKING: "working",
  WAITING: "waiting",
  COMPLETED: "completed",
  ERROR: "error",
  IDLE: "idle",
} as const;

export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

export const TONE = {
  DEFAULT: "default",
  SUCCESS: "success",
  WARNING: "warning",
  DANGER: "danger",
  INFO: "info",
  ACCENT: "accent",
  MUTED: "muted",
} as const;

export type Tone = (typeof TONE)[keyof typeof TONE];

export type Metric = {
  label: string;
  value: string | number;
  detail?: string;
  trend?: string;
  raw?: string;
  icon?: LucideIcon;
};

export type TabItem = {
  value: string;
  label: string;
  count?: number;
  icon?: LucideIcon;
};

export type FilterOption = {
  label: string;
  value: string;
};

export type FilterField = {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
};

export type SessionRow = {
  id: string;
  name: string;
  repo: string;
  model: string;
  harness: Harness;
  status: SessionStatus | string;
  startedAt: string;
  lastActivity: string;
  cost: number;
  agents: number;
  totalTokens?: number | null;
  durationLabel?: string;
  isRunDriven?: boolean;
  runHref?: string;
  awaitingInputSince?: string | null;
};

export type SessionControls = {
  title?: string;
  countLabel?: string;
  isLive?: boolean;
  liveLabel?: string;
  offlineLabel?: string;
  searchPlaceholder?: string;
  searchValue?: string;
  directoryValue?: string;
  directoryOptions: FilterOption[];
  harnessValue?: string;
  harnessOptions: FilterOption[];
  statusValue?: string;
  statusOptions: FilterOption[];
  sortValue?: string;
  sortOptions: FilterOption[];
  sortDescending?: boolean;
  refreshLabel?: string;
};

export type PaginationState = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type KanbanView = "agents" | "sessions";

export type ActivityItem = {
  id: string;
  method: string;
  title: string;
  badge: string;
  tone: Tone;
  time: string;
  summary: string;
  session?: string;
  details?: {
    label: string;
    value: string;
  }[];
};

export type RunStatus =
  | "idle"
  | "spawning"
  | "running"
  | "completed"
  | "error"
  | "killed"
  | "abandoned";

export type RunMode = "conversation" | "headless";

export type RunSummary = {
  id: string;
  title: string;
  promptPreview: string;
  status: RunStatus;
  mode: RunMode;
  cwd: string;
  model?: string | null;
  permissionMode: string;
  startedAt: string;
  endedAt?: string | null;
  sessionId?: string | null;
};

export type RunComposer = {
  mode: RunMode;
  source: "fresh" | "resume";
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: string;
  effort?: string;
  resumeSessionLabel?: string;
  slashCommands: Array<{
    name: string;
    description: string;
    source: "builtin" | "user" | "project";
  }>;
};

export type RunSessionRecord = {
  handle: RunSummary;
  transcript: ConversationTranscript;
  followUp?: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
  };
  result?: {
    durationLabel: string;
    turns: number;
    costUsd: number;
  };
};

export type CcScope = "all" | "user" | "project";

export type CcTabKey =
  | "overview"
  | "skills"
  | "agents"
  | "commands"
  | "outputStyles"
  | "plugins"
  | "marketplaces"
  | "mcp"
  | "hooks"
  | "keybindings"
  | "settings"
  | "memory";

export type CcCounts = {
  skills: { user: number; project: number };
  agents: { user: number; project: number };
  commands: { user: number; project: number };
  outputStyles: { user: number; project: number };
  plugins: number;
  marketplaces: number;
  mcpServers: { user: number; project: number };
  hooks: Record<string, number>;
  keybindings: number;
  settingsFiles: number;
  memory: number;
};

export type CcRoot = {
  label: string;
  value: string;
};

export type CcArtifact = {
  id: string;
  name: string;
  scope: "user" | "project";
  path: string;
  description?: string;
  tags?: string[];
  updatedAt?: string;
};

export type CcPlugin = {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  installPath: string;
  author?: string;
  license?: string;
  homepage?: string;
  contributes: Array<{
    label: string;
    count: number;
  }>;
};

export type CcMarketplace = {
  id: string;
  name: string;
  source: string;
  owner?: string;
  pluginCount: number;
  updatedAt?: string;
};

export type CcMcpServer = {
  id: string;
  name: string;
  scope: "user" | "project";
  transport: "command" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Array<{ label: string; value: string }>;
  env?: Array<{ label: string; value: string }>;
};

export type CcHookSource = {
  id: string;
  path: string;
  missing?: boolean;
  hooks: Array<{
    event: string;
    matcher?: string;
    command: string;
  }>;
};

export type CcHookScript = {
  id: string;
  path: string;
  command: string;
};

export type CcKeybindingGroup = {
  id: string;
  context: string;
  bindings: Array<{
    key: string;
    command: string;
  }>;
};

export type CcSettingsSource = {
  id: string;
  label: string;
  path: string;
  missing?: boolean;
  summary: Array<{
    label: string;
    value: string;
  }>;
};

export type CcStatusline = {
  configured: boolean;
  configPath?: string;
  scripts: Array<{
    id: string;
    path: string;
  }>;
};

export type CcMemoryItem = {
  id: string;
  scope: "user" | "project";
  path: string;
  preview: string;
  missing?: boolean;
};

export const CLI_TOOL_STATE = {
  CHECKING: "checking",
  DETECTED: "detected",
  CUSTOM: "custom",
  INVALID: "invalid",
  MISSING: "missing",
} as const;

export type CliToolState =
  (typeof CLI_TOOL_STATE)[keyof typeof CLI_TOOL_STATE];

export type CliTool = {
  id: string;
  name: string;
  description: string;
  path: string;
  hint: string;
  state: CliToolState;
};

export type DashboardSeriesPoint = {
  label: string;
  sessions: number;
  events: number;
};

export type DashboardLabelValue = {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
};

export type DashboardHealthRecord = {
  runtime: Metric[];
  storage: {
    totalLabel: string;
    breakdown: Array<{
      label: string;
      value: number;
      color: string;
    }>;
    details: DashboardLabelValue[];
  };
  healthScore: {
    value: number;
    factors: DashboardLabelValue[];
  };
  tokenUsage: Array<{
    label: string;
    value: number;
    color: string;
  }>;
  concurrency: WorkflowConcurrencyData;
  toolUsage: Array<{ name: string; count: number }>;
  effectiveness: WorkflowEffectivenessItem[];
  integrations: DashboardLabelValue[];
  platform: DashboardLabelValue[];
};

export type PanelAction = {
  label: string;
  icon?: LucideIcon;
};

export type HeaderProps = {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
};

export type Job = {
  id: string;
  command: string;
  label: string;
  status: string;
  startedAt: string;
  updatedAt?: string;
  repoPath?: string;
  phase?: string;
};

export type ApprovalAction = "approve" | "deny" | "always-allow";

export type Approval = {
  id: string;
  title: string;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied" | "expired" | "always-allow";
  reason: string;
  scope: string;
  createdAt: string;
};

export type SecurityKey = {
  id: string;
  ownerName: string;
  ownerEmail?: string;
  fingerprint: string;
  state: "authorized" | "pending";
};

export type FeatureFlag = {
  id: string;
  label: string;
  description: string;
  source: "default" | "user" | "env";
  enabled: boolean;
};

export type SavedConfig = {
  id: string;
  name: string;
  hasApiKey: boolean;
  active?: boolean;
};

export type SavedConfigStatus = {
  tone: "success" | "warning" | "error";
  message: string;
};

export type LogEntry = {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  tag: string;
  message: string;
  previousSession?: boolean;
};

export type PlanVersion = {
  id: string;
  version: number;
  content: string;
  createdAt: string;
};

export type Plan = {
  id: string;
  title: string;
  status: string;
  harness: Harness;
  captureMethod: string;
  confidence: number;
  needsConfirmation?: boolean;
  updatedAt: string;
  sessionId: string;
  planFile?: string;
  logFile?: string;
  versions: PlanVersion[];
};

export type ToolFacet = {
  id: string;
  name: string;
  count: number;
  lastSeen?: string;
};

export type ToolEvent = {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
  sessionId: string;
};

export type SkillInvocation = {
  id: string;
  sessionName: string;
  harness?: Harness;
  model?: string;
  cwd?: string;
  createdAt: string;
};

export type Skill = {
  id: string;
  name: string;
  pack: string;
  harness: Harness;
  version?: string;
  description?: string;
  invocationCount: number;
  lastInvokedAt?: string;
  invocations: SkillInvocation[];
};

export type SubagentDispatch = {
  id: string;
  name: string;
  type: string;
  status: string;
  task?: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
};

export type PullRequest = {
  id: string;
  repo: string;
  number: number;
  title?: string;
  url?: string;
  branch?: string;
  harness: Harness;
  state?: "open" | "merged" | "closed";
  author?: string;
  observedAt: string;
};

export type PullRequestSession = {
  id: string;
  sessionName: string;
  startedAt: string;
  cwd?: string;
  harness: Harness;
  pullRequests: PullRequest[];
};

export type EndpointConfig = {
  label: string;
  value: string;
};

export type RelaySettings = {
  targetId: string;
  relayOrigin: string;
  apiOrigin: string;
  webAppOrigin: string;
  apiKeyStatus: string;
  debugTokenStatus?: string;
  metrics: Metric[];
  endpoints: EndpointConfig[];
};

export type ShellNavItem = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string | number;
  active?: boolean;
};

export type ShellConnectionEvent = {
  type: string;
  at: string;
};

export type ShellConnectionSummary = {
  connected: boolean;
  connectedSince?: string | null;
  eventCount: number;
  peakPerSecond: number;
  lastEvent?: ShellConnectionEvent | null;
  recentEvents: ShellConnectionEvent[];
};

export type ShellUpdateStatus = {
  state: "idle" | "checking" | "available" | "up-to-date" | "error";
  label: string;
  detail?: string;
};

export type ShellLanguageOption = {
  code: string;
  label: string;
  active?: boolean;
};

export type ShellRecord = {
  title: string;
  productLabel?: string;
  embedded?: boolean;
  collapsed?: boolean;
  navItems: ShellNavItem[];
  connection: ShellConnectionSummary;
  update: ShellUpdateStatus;
  languages: ShellLanguageOption[];
};

export type RuntimePricingRule = {
  id: string;
  modelPattern: string;
  displayName: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  updatedAt?: string;
};

export type RuntimePricingDraft = Omit<
  RuntimePricingRule,
  "id" | "updatedAt"
>;

export type NotificationPreference = {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
};

export type SystemStatusItem = {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
  icon?: LucideIcon;
};

export type MaintenanceAction = {
  id: string;
  label: string;
  description: string;
  buttonLabel: string;
  tone?: Tone;
  danger?: boolean;
};

export type ImportHistoryItem = {
  id: string;
  filename: string;
  importedAt: string;
  sessions: number;
  events: number;
  status: "complete" | "partial" | "failed";
};

export type PolicyOverride = {
  operationId: string;
  tier: "high" | "medium" | "low" | "none";
};

export type AlwaysAllowRule = {
  id: string;
  operationId: string;
  method: string;
  path: string;
  scopePath?: string;
  expiresAt: string;
};

export type SecurityPosture = {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: "success" | "warning" | "danger";
};

export type SandboxPolicy = {
  allowedRoot?: string;
  warning?: string;
  deniedPaths: string[];
};

export type PackUsage = {
  toolCalls: number;
  sessions: number;
  firstUsedAt?: string | null;
  lastUsedAt?: string | null;
};

export type Pack = {
  id: string;
  displayName: string;
  category?: string;
  description?: string;
  stars?: number;
  harnesses: Harness[];
  installedHarnesses: Harness[];
  installedSkillCount: number;
  usageCount?: number;
  githubUrl?: string;
  marketplaceUrl?: string;
  placeholderReason?: string;
  installNotes?: string;
  projectScoped?: boolean;
  singleInstall?: boolean;
  uninstalledAt?: string | null;
  usage?: PackUsage | null;
  history?: Array<{
    label: string;
    stars: number | null;
    forks?: number | null;
  }>;
};

export type PackInstall = {
  harness: Harness;
  path: string;
  kind: "symlink" | "directory";
  version?: string;
};

export type PackInstallCommand = {
  harness: Harness;
  command: string;
  installed?: boolean;
  actionLabel?: string;
  commandIsAutoDetect?: boolean;
};

export type PackContentItem = {
  name: string;
  kind: "skill" | "command" | "agent" | "plugin";
  description?: string | null;
  category?: string | null;
  path?: string | null;
  skillCount?: number;
  skills?: string[];
};

export type PackPostInstall = {
  title: string;
  body: string;
  copyCommand?: string;
  url?: string;
  required?: boolean;
};

export type PackInstallRun = {
  action: "install" | "uninstall";
  harness: Harness;
  command: string;
  projectScoped?: boolean;
  commandIsAutoDetect?: boolean;
  state: "preview" | "running" | "complete";
  exitCode?: number;
  reason?: string;
  lines?: string[];
  projectOptions?: string[];
  selectedProject?: string;
  postInstall?: PackPostInstall | null;
};

export type PackDetail = {
  pack: Pack;
  verified?: boolean;
  githubUrl?: string;
  marketplaceUrl?: string;
  readme?: string | null;
  installCommands: PackInstallCommand[];
  installs: PackInstall[];
  skills: string[];
  contents?: PackContentItem[];
  sessions: SessionRow[];
};

export type WorkflowStats = {
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

export type WorkflowOrchestrationEdge = {
  source: string;
  target: string;
  weight: number;
};

export type WorkflowOrchestrationData = {
  sessionCount: number;
  mainCount: number;
  subagentTypes: Array<{
    subagentType: string;
    count: number;
    completed: number;
    errors: number;
  }>;
  edges: WorkflowOrchestrationEdge[];
  outcomes: Array<{ status: string; count: number }>;
  compactions: { total: number; sessions: number };
};

export type WorkflowToolFlowData = {
  transitions: Array<{
    source: string;
    target: string;
    value: number;
  }>;
  toolCounts: Array<{ toolName: string; count: number }>;
};

export type WorkflowEffectivenessItem = {
  subagentType: string;
  total: number;
  completed: number;
  errors: number;
  sessions: number;
  successRate: number;
  avgDuration: number | null;
  trend: number[];
};

export type WorkflowPattern = {
  steps: string[];
  count: number;
  percentage: number;
};

export type WorkflowPatternsData = {
  patterns: WorkflowPattern[];
  soloSessionCount: number;
  soloPercentage: number;
};

export type WorkflowModelDelegationData = {
  mainModels: Array<{
    model: string;
    agentCount: number;
    sessionCount: number;
  }>;
  subagentModels: Array<{ model: string; agentCount: number }>;
  tokensByModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
};

export type WorkflowErrorPropagationData = {
  byDepth: Array<{ depth: number; count: number }>;
  byType: Array<{ subagentType: string; count: number }>;
  eventErrors: Array<{ summary: string; count: number }>;
  sessionsWithErrors: number;
  totalSessions: number;
  errorRate: number;
};

export type WorkflowConcurrencyLane = {
  name: string;
  avgStart: number;
  avgEnd: number;
  count: number;
};

export type WorkflowConcurrencyData = {
  aggregateLanes: WorkflowConcurrencyLane[];
};

export type WorkflowComplexityItem = {
  id: string;
  name: string | null;
  status: string;
  duration: number;
  agentCount: number;
  subagentCount: number;
  totalTokens: number;
  model: string | null;
};

export type WorkflowCompactionImpactData = {
  totalCompactions: number;
  tokensRecovered: number;
  perSession: Array<{ sessionId: string; compactions: number }>;
  sessionsWithCompactions: number;
  totalSessions: number;
};

export type WorkflowData = {
  stats: WorkflowStats;
  orchestration: WorkflowOrchestrationData;
  toolFlow: WorkflowToolFlowData;
  effectiveness: WorkflowEffectivenessItem[];
  patterns: WorkflowPatternsData;
  modelDelegation: WorkflowModelDelegationData;
  errorPropagation: WorkflowErrorPropagationData;
  concurrency: WorkflowConcurrencyData;
  complexity: WorkflowComplexityItem[];
  compaction: WorkflowCompactionImpactData;
  cooccurrence: Array<{ source: string; target: string; weight: number }>;
};

export type WorkflowSessionDrillIn = {
  session: {
    id: string;
    name: string | null;
    status: string;
    cwd: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
  };
  tree: Array<{
    id: string;
    name: string;
    type: string;
    subagentType: string | null;
    status: string;
    task: string | null;
    startedAt: string;
    endedAt: string | null;
    children: WorkflowSessionDrillIn["tree"];
  }>;
  toolTimeline: Array<{
    id: number;
    toolName: string;
    eventType: string;
    agentId: string | null;
    createdAt: string;
    summary: string | null;
  }>;
  swimLanes: Array<{
    id: string;
    name: string;
    type: string;
    subagentType: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    parentAgentId: string | null;
  }>;
  events: Array<{
    id: number;
    sessionId: string;
    agentId: string | null;
    eventType: string;
    toolName: string | null;
    summary: string | null;
    createdAt: string;
  }>;
};

export type SessionOverviewStats = {
  totalEvents: number;
  toolCalls: number;
  subagents: number;
  compactions: number;
  errors: number;
  durationLabel: string;
  eventRateHint?: string;
  topTools: Array<{ toolName: string; count: number }>;
  subagentTypes: Array<{
    label: string;
    count: number;
    isCompaction?: boolean;
  }>;
  tokens: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  eventMix: Array<{ eventType: string; count: number }>;
  activeAgent?: {
    name: string;
    currentTool?: string | null;
    task?: string | null;
  } | null;
};

export type SessionAgent = {
  id: string;
  sessionId: string;
  name: string;
  type: "main" | "subagent";
  subagentType?: string | null;
  status: AgentStatus;
  task?: string | null;
  currentTool?: string | null;
  startedAt: string;
  updatedAt?: string | null;
  endedAt?: string | null;
  model?: string | null;
  cost?: number | null;
  label?: string | null;
  children?: SessionAgent[];
};

export type SessionEvent = {
  id: string;
  sessionId: string;
  agentId?: string | null;
  agentLabel?: string | null;
  project?: string | null;
  eventType: string;
  status: AgentStatus;
  toolName?: string | null;
  title: string;
  summary?: string | null;
  createdAt: string;
  rawData?: string | null;
  metadata?: Array<{
    label: string;
    value: string;
  }>;
  detail?: EventDetail;
};

export type SessionEventGroup = {
  id: string;
  title: string;
  durationLabel?: string;
  events: SessionEvent[];
};

export type SessionEventFacets = {
  statuses: string[];
  eventTypes: string[];
  toolNames: string[];
  agents: Array<{
    id: string;
    label: string;
  }>;
};

export type EventFilterSelection = {
  query?: string;
  from?: string;
  to?: string;
  statuses: string[];
  eventTypes: string[];
  toolNames: string[];
  agents: Array<{
    id: string;
    label: string;
  }>;
  sessions?: Array<{
    id: string;
    label: string;
  }>;
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EventDetailField = {
  key: string;
  label: string;
  value: JsonValue;
};

export type EventDetail = {
  summary?: {
    headline: string;
    bullets?: string[];
  };
  fields: EventDetailField[];
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  author: string;
  createdAt: string;
  content: string;
  toolName?: string | null;
  model?: string | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  blocks?: ConversationContentBlock[];
};

export type ConversationContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: JsonValue;
    }
  | {
      type: "tool_result";
      id: string;
      output: JsonValue;
      isError?: boolean;
    };

export type ConversationEnvelope =
  | {
      id: string;
      type: "user";
      createdAt?: string;
      author?: string;
      content: ConversationContentBlock[];
    }
  | {
      id: string;
      type: "assistant";
      createdAt?: string;
      author?: string;
      content: ConversationContentBlock[];
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      } | null;
      streaming?: boolean;
    }
  | {
      id: string;
      type: "system";
      createdAt?: string;
      subtype?: string;
      sessionId?: string;
      model?: string;
      cwd?: string;
      tools?: string[];
      permissionMode?: string;
    }
  | {
      id: string;
      type: "result";
      createdAt?: string;
      isError?: boolean;
      durationMs?: number;
      turns?: number;
      sessionId?: string;
      costUsd?: number;
      result?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
      } | null;
    }
  | {
      id: string;
      type: string;
      createdAt?: string;
      data: JsonValue;
    };

export type ConversationTranscript = {
  id: string;
  label: string;
  agentId?: string | null;
  agentLabel?: string | null;
  status?: AgentStatus | null;
  messages: ConversationMessage[];
  envelopes?: ConversationEnvelope[];
  totalMessages?: number;
  hasMoreHistory?: boolean;
  loadingHistory?: boolean;
  refreshing?: boolean;
  newMessagesAvailable?: boolean;
};

export type RawDashboardEvent = {
  id: number | string;
  session_id: string;
  agent_id: string | null;
  event_type: string;
  tool_name: string | null;
  summary: string | null;
  data: string | null;
  created_at: string;
};

export type RawTranscriptContent = {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown> | { _truncated: string };
  output?: string;
  is_error?: boolean;
};

export type RawTranscriptMessage = {
  type: "user" | "assistant";
  timestamp: string | null;
  content: RawTranscriptContent[];
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type SessionDetailRecord = {
  session: SessionRow & {
    cwd: string;
    endedAt?: string | null;
    summary?: string;
  };
  overview: SessionOverviewStats;
  agents: SessionAgent[];
  eventFacets: SessionEventFacets;
  activeEventFilters?: EventFilterSelection;
  eventGroups: SessionEventGroup[];
  transcripts: ConversationTranscript[];
  activeTranscriptId?: string;
  activeAgentId?: string;
};

export type ActivityFeedRecord = {
  title: string;
  description?: string;
  live?: boolean;
  paused?: boolean;
  bufferedCount?: number;
  grouped?: boolean;
  filters: EventFilterSelection;
  availableFilters?: SessionEventFacets & {
    sessions?: FilterOption[];
  };
  groupedEvents: SessionEventGroup[];
  flatEvents: SessionEvent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages?: number;
  };
};

export type AnalyticsMetricPoint = {
  label: string;
  value: number;
};

export type AnalyticsHeatmapWeek = Array<{
  date: string;
  count: number;
}>;

export type AnalyticsCostBreakdown = {
  label: string;
  cost: number;
  color: string;
};
