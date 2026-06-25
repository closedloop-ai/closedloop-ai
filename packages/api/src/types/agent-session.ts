import { z } from "zod";
import type { JsonObject, JsonValue } from "./common.js";
import type { DocumentType } from "./document.js";
import type {
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "./session-artifact-link.js";
import type { BasicUser } from "./user.js";

export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  "desktop.agent-sessions" as const;
export const DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY =
  "desktop-agent-session-sync" as const;
export const AGENT_SESSION_SYNC_SCHEMA_VERSION = 1 as const;

/**
 * Compatibility tombstone emitted by the removed Session Trace state-action
 * endpoint for stale browser bundles that still call the old route.
 */
export const AgentSessionStateActionRemoval = {
  Message: "Agent session state actions are no longer supported",
  Code: "agent_session_state_actions_removed",
} as const;
export type AgentSessionStateActionRemoval =
  (typeof AgentSessionStateActionRemoval)[keyof typeof AgentSessionStateActionRemoval];

export const AgentSessionState = {
  PendingApproval: "PENDING_APPROVAL",
  Blocked: "BLOCKED",
  InReview: "IN_REVIEW",
  Running: "RUNNING",
  Completed: "COMPLETED",
} as const;
export type AgentSessionState =
  (typeof AgentSessionState)[keyof typeof AgentSessionState];

const agentSessionStateValues = Object.values(AgentSessionState) as [
  AgentSessionState,
  ...AgentSessionState[],
];

/** Validator for persisted Session Trace workflow state values. */
export const agentSessionStateValidator = z.enum(agentSessionStateValues);

export const AgentSessionOrigin = {
  DesktopSync: "DESKTOP_SYNC",
  Loop: "LOOP",
} as const;
export type AgentSessionOrigin =
  (typeof AgentSessionOrigin)[keyof typeof AgentSessionOrigin];

export const AgentSessionSyncMode = {
  Backfill: "backfill",
  Incremental: "incremental",
} as const;
export type AgentSessionSyncMode =
  (typeof AgentSessionSyncMode)[keyof typeof AgentSessionSyncMode];

export const DesktopAgentSessionsAckReason = {
  FeatureDisabled: "feature_disabled",
  IngestionFailed: "ingestion_failed",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
} as const;
export type DesktopAgentSessionsAckReason =
  (typeof DesktopAgentSessionsAckReason)[keyof typeof DesktopAgentSessionsAckReason];

export type DesktopAgentSessionsAck =
  | { accepted: true }
  | { accepted: false; reason: DesktopAgentSessionsAckReason };

export type SyncedAgentSessionAttribution = {
  repositoryFullName?: string | null;
  worktreePath?: string | null;
  sourceArtifactId?: string | null;
  sourceLoopId?: string | null;
  issueId?: string | null;
  baseBranch?: string | null;
};

export type SyncedAgentSessionAgent = {
  externalAgentId: string;
  name: string;
  type: string;
  subagentType?: string | null;
  status: string;
  task?: string | null;
  currentTool?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  endedAt?: string | null;
  awaitingInputSince?: string | null;
  parentExternalAgentId?: string | null;
  metadata?: JsonObject | null;
};

export type SyncedAgentSessionEvent = {
  externalEventId: string;
  agentExternalId?: string | null;
  eventType: string;
  toolName?: string | null;
  summary?: string | null;
  data?: JsonValue;
  createdAt: string;
};

export type SyncedAgentSessionTokenUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd?: number;
};

export type SyncedAgentSession = {
  externalSessionId: string;
  name?: string | null;
  status: string;
  /**
   * Per-session billing mode the desktop resolves from its local billing_mode
   * column (subscription vs. API-key plan). Optional + additive — older desktop
   * builds omit it. The cloud uses it to classify DESKTOP_SYNC sessions (which
   * have no source Loop) in the usage cost split.
   */
  billingMode?: string | null;
  harness?: string | null;
  cwd?: string | null;
  model?: string | null;
  startedAt: string;
  updatedAt: string;
  /**
   * PLN-1034: genuine-activity timestamp — the latest real agent event, floored
   * at startedAt. Optional + additive (older Desktop builds omit it; the cloud
   * derives the authoritative value from the synced event stream regardless).
   * Distinct from `updatedAt`, which is bumped by OTEL ingest / enrichment / sync
   * bookkeeping that is not activity.
   */
  lastActivityAt?: string | null;
  endedAt?: string | null;
  awaitingInputSince?: string | null;
  metadata?: JsonObject | null;
  attribution?: SyncedAgentSessionAttribution;
  /**
   * FEA-1459: device IANA timezone (e.g. "America/Chicago") for timezone-aware
   * day attribution in cloud views and CSV export. Optional + additive — the
   * schema version is unchanged. Older desktop builds omit the field; the cloud
   * treats an absent value as UTC.
   */
  deviceTimeZone?: string | null;
  /** Optional bounded Session Trace metadata; omission preserves cloud values. */
  branch?: string | null;
  issues?: string[] | null;
  prs?: SessionPR[] | null;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  gitDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  branchDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  turns?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  activityBuckets?: ActivityBucket[] | null;
  span?: SessionSpan | null;
  markers?: SessionMarker[] | null;
  throttles?: SessionThrottle[] | null;
  tracePhaseSources?: SessionTracePhaseSource[] | null;
  throttleSources?: SessionTraceThrottleSource[] | null;
  correctionSources?: SessionTraceCorrectionSource[] | null;
  phases?: SessionPhase[] | null;
  phaseIterations?: PhaseIterations | null;
  phaseLoopbacks?: PhaseLoopback[] | null;
  dataRevision?: number | null;
  artifactRefs?: SyncedArtifactRef[];
  prRefs?: SyncedSessionPrRef[];
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
  tokenUsageByModel: SyncedAgentSessionTokenUsage[];
};

export type DesktopAgentSessionsPayload = {
  schemaVersion: typeof AGENT_SESSION_SYNC_SCHEMA_VERSION;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  sessions: SyncedAgentSession[];
};

export type AgentSessionHarnessBreakdown = {
  harness: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByUser = {
  userId: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByModel = {
  model: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionLastSyncTarget = {
  computeTargetId: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  owner: BasicUser;
};

export type AgentSessionProjectSummary = {
  id: string;
  name: string;
  slug: string | null;
};

export type AgentSessionComputeTargetSummary = {
  id: string;
  machineName: string;
  isOnline: boolean;
  lastSeenAt: Date;
};

export type AgentSessionSourceArtifactSummary = {
  id: string;
  name: string;
  slug: string | null;
  documentType: DocumentType | null;
};

export type SessionPR = {
  num: number | string;
  title: string;
  status: string;
};

export type SessionTimelineEvent = {
  t: string;
  tMs?: number;
  kind:
    | "tool"
    | "edit"
    | "mcp"
    | "slash"
    | "result"
    | "event"
    | "human"
    | "say";
  who?: string;
  title?: string;
  detail?: string;
  err?: boolean | string;
  git?: boolean;
  tl?: number;
  /** Model that produced an assistant `say` row, surfaced as a bubble caption. */
  model?: string | null;
  /** Marks an assistant `say` row as a reasoning/thinking block. */
  isThinking?: boolean;
  /**
   * Marks a content-free end-of-turn hook (`Stop`/`SubagentStop`). Set from the
   * raw producer hook name so the detail projection can drop it structurally
   * rather than by matching display text.
   */
  isBoundary?: boolean;
};

export type ActivityBucket = {
  /** Stable local/render identity for derived timeline buckets. */
  key?: string;
  label: string;
  cIn: number;
  cOut: number;
  cCache: number;
  total: number;
  toolStart: number;
  tl0: number | null;
  byModel: Record<string, { cIn: number; cOut: number; cCache: number }>;
};

export type SessionSpan = {
  first: string;
  last: string;
};

export type SessionMarker = {
  kind: "commit" | "pr" | "fail" | "frust" | "prompt";
  x: number;
  t: string;
  label: string;
  tl: number;
  illustrative?: boolean;
};

export type SessionThrottle = {
  x0: number;
  t0: string;
  t1: string;
  durMin: number;
  tl: number;
};

export const SessionTracePhaseSourceType = {
  LoopPerf: "loop_perf",
  Explicit: "explicit",
} as const;
export type SessionTracePhaseSourceType =
  (typeof SessionTracePhaseSourceType)[keyof typeof SessionTracePhaseSourceType];

export type SessionTracePhaseSource = {
  sourceType: SessionTracePhaseSourceType;
  phaseKey: string;
  label?: string | null;
  startedAt: string;
  endedAt?: string | null;
};

export const SessionTraceThrottleSourceType = {
  ProviderRateLimit: "provider_rate_limit",
  UsageLimit: "usage_limit",
  ApiError: "api_error",
  TokenSnapshot: "token_snapshot",
} as const;
export type SessionTraceThrottleSourceType =
  (typeof SessionTraceThrottleSourceType)[keyof typeof SessionTraceThrottleSourceType];

export type SessionTraceThrottleSource = {
  sourceType: SessionTraceThrottleSourceType;
  provider: string;
  observedAt: string;
  limitKind?: string | null;
  statusCode?: number | null;
  errorCode?: string | null;
  resetAt?: string | null;
  retryAfterSeconds?: number | null;
};

export const SessionTraceCorrectionSourceKind = {
  ManualRegression: "manual_regression",
  ReviewChangeRequest: "review_change_request",
  ApprovalDenied: "approval_denied",
  NegativeFeedback: "negative_feedback",
  ExplicitCorrection: "explicit_correction",
} as const;
export type SessionTraceCorrectionSourceKind =
  (typeof SessionTraceCorrectionSourceKind)[keyof typeof SessionTraceCorrectionSourceKind];

export type SessionTraceCorrectionSource = {
  kind: SessionTraceCorrectionSourceKind;
  observedAt: string;
  label?: string | null;
  sourceType?: string | null;
};

export type SessionPhase = {
  key: string;
  label: string;
  dur: string;
  cost: string;
  cOut: number;
  cCache: number;
  cIn: number;
};

export type PhaseIterations = Record<string, number>;

export type PhaseLoopback = {
  from: string;
  to: string;
  label: string;
  depth: number;
};

export type TurnActor = {
  name: string | null;
  sessionId: string;
  human: string | null;
  color: string;
  harness?: string | null;
};

export type ToolItem = {
  label: string;
  detail: string;
  err: boolean;
};

export type ToolCats = {
  bash?: number;
  read?: number;
  tool?: number;
};

export type SubagentBodyLine = {
  kind: "task" | "tool" | "event" | "status";
  text: string;
  t?: string;
  err?: boolean;
};

export type TurnItem =
  | {
      type: "sessionstart";
      t: string;
      actor: TurnActor & {
        machine?: string;
        isNew?: boolean;
        isResumed?: boolean;
        ci?: boolean;
      };
    }
  | {
      type: "prompt";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      actor: TurnActor;
      text: string;
    }
  | {
      type: "say";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      actor: TurnActor;
      text: string;
      /** Model that produced this turn, rendered as a muted bubble caption. */
      model?: string | null;
      /** True when this turn is a reasoning/thinking block, not a response. */
      isThinking?: boolean;
    }
  | {
      type: "tools";
      _row: number;
      t: string;
      tMs: number;
      endMs: number;
      cum: number;
      actor: TurnActor;
      summary: string;
      items: ToolItem[];
      hasFail: boolean;
      failN: number;
      defaultOpen?: boolean;
      cats: ToolCats;
    }
  | {
      type: "subagent";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      actor: TurnActor;
      sub: string;
      subagentType: string | null;
      status: string;
      model: string | null;
      duration: string | null;
      tokens: string | null;
      cost: string | null;
      body: SubagentBodyLine[];
    }
  | {
      type: "event";
      _row: number;
      t: string;
      tMs: number;
      dot: "g" | "b" | "r";
      text: string;
      tag?: string;
    }
  | { type: "idle"; gap: number }
  | { type: "end"; text: string };

/**
 * @deprecated Compatibility type for stale clients that may still import the
 * removed Session Trace state-action endpoint response.
 */
export type AgentSessionStateUpdateResponse = {
  state: AgentSessionState;
};

export type AgentSessionListItem = {
  id: string;
  // SES-* slug of the backing Session artifact (FEA-1699). Null only until a
  // slug is allocated (every synced/backfilled session has one).
  slug: string | null;
  externalSessionId: string;
  name: string | null;
  status: string;
  origin?: AgentSessionOrigin;
  state?: AgentSessionState;
  harness: string;
  cwd: string | null;
  repositoryFullName: string | null;
  repo?: string | null;
  worktreePath: string | null;
  model: string | null;
  primaryModel?: string | null;
  models?: string[];
  branch?: string | null;
  issues?: string[];
  prs?: SessionPR[];
  prsMerged?: number;
  cost?: string | null;
  wallClock?: string | null;
  activeAgent?: string | null;
  waitingUser?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  gitDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  branchDiffStats?: {
    linesAdded: number;
    linesRemoved: number;
    filesChanged: number;
    source: string;
  } | null;
  turns?: number | null;
  toolCallsTotal?: number | null;
  steeringEpisodes?: number | null;
  autonomy?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  cache?: number | null;
  cacheWrite?: number | null;
  userColor?: string | null;
  activityBuckets?: ActivityBucket[];
  span?: SessionSpan | null;
  markers?: SessionMarker[];
  throttles?: SessionThrottle[];
  phases?: SessionPhase[];
  phaseIterations?: PhaseIterations;
  phaseLoopbacks?: PhaseLoopback[];
  startedAt: Date;
  updatedAt: Date;
  /**
   * PLN-1034: genuine-activity timestamp (latest real agent event, floored at
   * startedAt). Always populated for list rows — the default Sessions sort.
   */
  lastActivityAt: Date;
  endedAt: Date | null;
  awaitingInputSince: Date | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  agentCount: number;
  toolUseCount: number;
  errorCount: number;
  issueId: string | null;
  baseBranch: string | null;
  sourceArtifactId: string | null;
  sourceArtifact?: AgentSessionSourceArtifactSummary | null;
  sourceLoopId: string | null;
  // Nullable since FEA-1699: a Session artifact survives its owner's deletion as
  // an org-owned record (session_detail.user_id is SetNull on user deletion).
  user: BasicUser | null;
  computeTarget: AgentSessionComputeTargetSummary;
  project: AgentSessionProjectSummary | null;
};

export type AgentSessionListResponse = {
  items: AgentSessionListItem[];
  total: number;
  viewerScope: "organization" | "self";
};

export type AgentSessionDetail = AgentSessionListItem & {
  metadata: JsonObject | null;
  sourceArtifactId: string | null;
  sourceLoopId: string | null;
  tokenUsageByModel: SyncedAgentSessionTokenUsage[];
  attribution: SyncedAgentSessionAttribution | null;
  agents: SyncedAgentSessionAgent[];
  events: SyncedAgentSessionEvent[];
  timeline?: SessionTimelineEvent[];
  turnItems?: TurnItem[];
  tracePhaseSources?: SessionTracePhaseSource[];
  throttleSources?: SessionTraceThrottleSource[];
  correctionSources?: SessionTraceCorrectionSource[];
};

export type AgentSessionUsageSummary = {
  viewerScope: "organization" | "self";
  totalSessions: number;
  /**
   * Earliest session start (ISO timestamp) across all matching sessions, or
   * null when none match. Together with `latestSessionAt`, describes the time
   * span the aggregate totals cover.
   */
  earliestSessionAt: string | null;
  /** Latest session start (ISO timestamp) across matching sessions, or null when none match. */
  latestSessionAt: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedCost: number;
  /** Cost on subscription-covered compute targets (loop apiKeySource === 'none') */
  subscriptionEstimatedCost: number;
  /** Cost on API-key compute targets (loop apiKeySource is set, or no source loop) */
  apiEstimatedCost: number;
  byUser: AgentSessionUsageByUser[];
  byModel: AgentSessionUsageByModel[];
  byHarness: AgentSessionHarnessBreakdown[];
  /** Per-repository breakdown — sources the Repository filter facet. */
  byRepository: AgentSessionRepositoryBreakdown[];
  lastSyncTargets: AgentSessionLastSyncTarget[];
};

export type AgentSessionToolBreakdown = {
  toolName: string;
  invocationCount: number;
  errorCount: number;
  sessionCount: number;
};

export type AgentSessionAgentTypeBreakdown = {
  agentType: string;
  count: number;
  successCount: number;
  failedCount: number;
  avgDurationMs: number | null;
};

export type AgentSessionRepositoryBreakdown = {
  repositoryFullName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCount: number;
};

export type AgentSessionProjectBreakdown = {
  projectId: string;
  projectName: string;
  projectSlug: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

export type AgentSessionAnalytics = {
  viewerScope: "organization" | "self";
  byTool: AgentSessionToolBreakdown[];
  byAgentType: AgentSessionAgentTypeBreakdown[];
  byRepository: AgentSessionRepositoryBreakdown[];
  byProject: AgentSessionProjectBreakdown[];
};
