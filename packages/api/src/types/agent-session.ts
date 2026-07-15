import { z } from "zod";
import type { JsonObject, JsonValue } from "./common.js";
import type { TranscriptAvailabilitySummary } from "./desktop-transcripts.js";
import type { DocumentType } from "./document.js";
import type { ReadSource } from "./read-source.js";
import type {
  SessionPrPurpose,
  SyncedArtifactRef,
  SyncedSessionPrRef,
} from "./session-artifact-link.js";
import type { BasicUser } from "./user.js";

// ---------------------------------------------------------------------------
// Sync contract types for agent component inventory + usage (T-6.4)
// ---------------------------------------------------------------------------

/**
 * One inventory entry for a harness component, as materialized by the desktop
 * at transcript import time and shipped to the cloud via
 * `POST /desktop/components/sync`.
 *
 * Keyed by `(componentKind, externalComponentId)` on the desktop side; the
 * cloud upserts keyed by `(computeTargetId, componentKind, externalComponentId)`.
 * `uninstalledAt` set ⇒ tombstone the cloud row.
 */
export type SyncedComponent = {
  externalId: string;
  componentKind: string;
  harness?: string | null;
  name?: string | null;
  componentKey?: string | null;
  version?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  installPath?: string | null;
  packId?: string | null;
  scope?: string | null;
  projectPath?: string | null;
  metadata?: JsonObject | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  uninstalledAt?: string | null;
};

/**
 * Per-session usage metrics for a single component, included in the
 * `components[]` array on `SyncedAgentSession`.
 *
 * Keyed by `(agentSessionId, componentKind, componentKey)` in the cloud
 * `agent_component_session_usage` table. `externalComponentId` is nullable —
 * built-in tools (e.g. Read/Bash) have no `AgentComponent` inventory row and
 * resolve `agentComponentId` to null.
 */
export type SyncedComponentUsage = {
  componentKind: string;
  componentKey: string;
  externalComponentId?: string | null;
  harness?: string | null;
  invocations: number;
  errorCount: number;
  firstInvokedAt?: string | null;
  lastInvokedAt?: string | null;
  /**
   * FEA-2990: the git branch this usage bucket actually ran on, from per-event
   * `events.git_branch`. Additive/optional: omitted (or null) for branch-less
   * buckets (Codex, legacy pre-column events, and non-tool kinds), in which case
   * the cloud falls back to session-level `SessionBranch` attribution. A session
   * that switched branches mid-run sends one entry per (component, branch).
   */
  gitBranch?: string | null;
};

export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  "desktop.agent-sessions" as const;
export const DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY =
  "desktop-agent-session-sync" as const;
/**
 * Canonical PostHog flag key that gates the Agents feature on both surfaces:
 * the client Agents UI (`apps/app`, via the `@repo/app` re-export) and the
 * server loop context-pack (`apps/api/lib/loops/loop-context-pack.ts`). Both
 * import this single constant so a typo on either side can't silently gate them
 * differently for the same flag.
 */
export const AGENTS_FEATURE_FLAG_KEY = "agents" as const;
/**
 * FEA-2718 (PLN-1294) bumps this 1 → 2. Dropping `summary`/`data` from the event
 * schema is itself backward-compatible (a stale desktop's turn text is stripped
 * on ingest and never persisted), but the plan requires the bump so a
 * desktop/API deploy skew is loud and immediate: the API pins acceptance to this
 * literal, so a desktop still on v1 is rejected until it updates rather than
 * silently syncing the pre-FEA-2718 shape. The internal fleet updates in lockstep
 * with the API deploy. The cloud transcript archive (FEA-2717) is the sole source
 * of turn/tool detail; the DB keeps only columnar event metadata.
 *
 * The value 2 is now free: the event-fragment transport that previously used a
 * separate `schemaVersion` 2 was retired in FEA-2718 (slim events always fit one
 * envelope), so there is no collision. The desktop mirror of this constant in
 * `apps/desktop/src/main/agent-session-sync-contract.ts` must move in lockstep.
 */
export const AGENT_SESSION_SYNC_SCHEMA_VERSION = 2 as const;

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

// FEA-2718: with the event-fragment transport retired, a batch either fully
// syncs or is rejected — there is no longer a `pendingFragments` continuation.
export const desktopAgentSessionsSyncResponseValidator = z
  .object({ synced: z.literal(true) })
  .strict();
export type DesktopAgentSessionsSyncResponse = z.infer<
  typeof desktopAgentSessionsSyncResponseValidator
>;

export const desktopAgentSessionsSyncApiResultValidator = z.union([
  z
    .object({
      success: z.literal(true),
      data: desktopAgentSessionsSyncResponseValidator,
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .passthrough(),
]);
export type DesktopAgentSessionsSyncApiResult = z.infer<
  typeof desktopAgentSessionsSyncApiResultValidator
>;

export type SyncedAgentSessionAttribution = {
  repositoryFullName?: string | null;
  worktreePath?: string | null;
  sourceArtifactId?: string | null;
  sourceLoopId?: string | null;
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
  /**
   * Desktop-local-only turn/tool text. FEA-2718 removed these from the CLOUD
   * lane: the desktop no longer syncs them, and the cloud no longer persists or
   * returns them (the `agent_session_events.summary`/`data` columns are dropped
   * and the sync Zod omits them, so a stale desktop that still sends them has the
   * keys stripped on ingest). They remain optional here solely because the
   * desktop-local detail render still hydrates them from its own local SQLite to
   * build the local trace — so cloud reads leave them `undefined` while the web
   * renders turn/tool detail from the archived transcript (FEA-2717). The
   * desktop → cloud transcript migration is tracked by PRD-461.
   */
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

/**
 * FEA-2730 (G1): one raw per-event token-usage row synced from the desktop
 * `token_events` table. The source table has no primary key, so the desktop
 * synthesizes `externalEventId` as a content hash of the row; the cloud stores
 * these keyed by (session, externalEventId) so a re-sync is an idempotent
 * no-op. Token counts cross the wire as JS numbers within the 2^53 envelope
 * (like `tokenUsageByModel`) and land in BigInt columns.
 */
export type SyncedAgentSessionTokenEvent = {
  externalEventId: string;
  agentExternalId?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd?: number;
  /** ISO timestamp; persisted as the cloud `eventCreatedAt`. */
  createdAt: string;
};

/**
 * FEA-2730 (G10): the desktop's one-row-per-session analytics rollup
 * (`session_analytics`), synced as-is and authoritative (Q16). Optional +
 * additive — older desktop builds omit it, and an omitted rollup must never
 * clear a previously synced one. `updatedAt` is the desktop's recompute time
 * (persisted as `rollupUpdatedAt`), not a cloud bookkeeping stamp.
 */
export type SyncedAgentSessionAnalytics = {
  startedAt?: string | null;
  startedDay?: string | null;
  status?: string | null;
  harness?: string | null;
  isHuman: boolean;
  humanTurns: number;
  agentTurns: number;
  eventCount: number;
  toolInvocations: number;
  errorEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd?: number;
  runtimeMs?: number | null;
  updatedAt?: string | null;
};

export type TokenEventCostPoint = {
  tMs: number;
  costUsd: number;
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
  attribution?: SyncedAgentSessionAttribution | null;
  /**
   * FEA-1459: device IANA timezone (e.g. "America/Chicago") for timezone-aware
   * day attribution in cloud views and CSV export. Optional + additive — the
   * schema version is unchanged. Older desktop builds omit the field; the cloud
   * treats an absent value as UTC.
   */
  deviceTimeZone?: string | null;
  /** Optional bounded Session Trace metadata; omission preserves cloud values. */
  branch?: string | null;
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
  /**
   * FEA-2730 (G1): raw per-event token rows. Optional + additive; an omitted
   * array means "no replacement data" and leaves previously persisted rows
   * untouched (like `tokenUsageByModel`). Distributed across chunks for
   * oversized sessions and upserted idempotently cloud-side.
   */
  tokenEvents?: SyncedAgentSessionTokenEvent[];
  /**
   * FEA-2730 (G10): the desktop per-session analytics rollup (1:1). Optional +
   * additive; omission never clears a previously synced rollup.
   */
  sessionAnalytics?: SyncedAgentSessionAnalytics | null;
  /**
   * T-6.4 / AC-011: per-component usage metrics for this session. Optional +
   * additive — older desktop builds omit it; omission leaves previously
   * persisted `agent_component_session_usage` rows untouched. The cloud Zod
   * schema accepts this field before the desktop begins emitting it (deploy
   * ordering: cloud before desktop release).
   *
   * Each entry is upserted into `AgentComponentSessionUsage` keyed by
   * `(agentSessionId, componentKind, componentKey)`. `externalComponentId`
   * resolves to an `agentComponentId` FK via a LEFT JOIN — null for built-in
   * tools that have no inventory row (hook/config/built-in).
   */
  components?: SyncedComponentUsage[];
};

export type DesktopAgentSessionsPayload = {
  schemaVersion: typeof AGENT_SESSION_SYNC_SCHEMA_VERSION;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  sessions: SyncedAgentSession[];
};

// FEA-2718: the event-fragment payload types were removed with the transport.
// A sync payload is now always a whole-session batch.
export type DesktopAgentSessionsSyncPayload = DesktopAgentSessionsPayload;

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

export const SessionPrLifecycleStatus = {
  Merged: "merged",
  Closed: "closed",
  Open: "open",
  Unknown: "unknown",
} as const;
export type SessionPrLifecycleStatus =
  (typeof SessionPrLifecycleStatus)[keyof typeof SessionPrLifecycleStatus];

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
      costDelta?: number;
      actor: TurnActor;
      text: string;
    }
  | {
      type: "say";
      _row: number;
      t: string;
      tMs: number;
      cum: number;
      costDelta?: number;
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
      costDelta?: number;
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
      costDelta?: number;
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
  viewerScope: AgentSessionViewerScope;
  /**
   * FEA-3120: which store produced these rows — `local` (desktop SQLite via IPC),
   * `cloud` (synced cloud state via `apps/api`), or `fallback` (degraded/empty
   * best-effort). Populated at the read boundary in each data source, not by the
   * DB query. Optional so older/wire producers stay compatible; consumers treat
   * an absent value as "unknown source" and render nothing rather than guess.
   */
  readSource?: ReadSource;
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
  /**
   * FR8 per-file transcript availability summary (FEA-2716 / PLN-1289). Always
   * includes the main transcript (as `missing` when it has no row yet), plus an
   * entry per subagent file — matching the read route's synthesis (PRD AC6).
   * Lets list/detail UIs show availability without minting a signed URL — the
   * read route does that on explicit access.
   */
  transcripts?: TranscriptAvailabilitySummary[];
};

export type AgentSessionUsageSummary = {
  viewerScope: AgentSessionViewerScope;
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
  /**
   * FEA-3156 — delivery-summary metrics for the Sessions page top row, computed
   * over the SAME matched-session set as the totals above via the delivery-KPI
   * SSOT engine.
   *
   * OPTIONAL because only the cloud sessions-usage endpoint computes them (via
   * the merged-PR read layer). Surfaces without that backing (e.g. the desktop
   * local SQLite producer) omit them; the summary cards then fall back to the
   * "unavailable" placeholder rather than fabricating a value.
   *
   * `mergedPrCount` — count of merged PRs linked to the matched sessions
   * ("merged in range"). A real count (0, never null) when present.
   */
  mergedPrCount?: number;
  /**
   * Median gross lines (additions + deletions) across those merged PRs. Null
   * when there are no merged PRs to measure; undefined when the surface does not
   * compute it.
   */
  medianPrSize?: number | null;
  /**
   * Merged KLOC ÷ token cost across the matched sessions. Null when there are no
   * merged lines to count or no cost to divide by; undefined when the surface
   * does not compute it.
   */
  mergedKlocPerDollar?: number | null;
  byUser: AgentSessionUsageByUser[];
  /** Optional query-time lens that splits each session across linked branches. */
  byBranch?: AgentSessionUsageByBranch[];
  /** Optional query-time lens that re-keys trusted current-PR branch shares. */
  byPr?: AgentSessionUsageByPr[];
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

export type AgentSessionUsageByBranch = {
  branchArtifactId: string;
  repositoryFullName: string | null;
  branchName: string | null;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

export type AgentSessionUsageByPr = {
  repositoryFullName: string;
  prNumber: number;
  prTitle: string | null;
  branchArtifactId: string;
  purpose: SessionPrPurpose;
  purposeLabel: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
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
  viewerScope: AgentSessionViewerScope;
  byTool: AgentSessionToolBreakdown[];
  byAgentType: AgentSessionAgentTypeBreakdown[];
  byRepository: AgentSessionRepositoryBreakdown[];
  byProject: AgentSessionProjectBreakdown[];
  /** Optional query-time lens that splits each session across linked branches. */
  byBranch?: AgentSessionUsageByBranch[];
  /** Optional query-time lens that re-keys trusted current-PR branch shares. */
  byPr?: AgentSessionUsageByPr[];
};

/**
 * Viewer scope values accepted by agent-session list, usage, analytics, and
 * export routes. Use these const members instead of raw string literals so
 * route validators, services, and tests cannot drift.
 */
export const AgentSessionViewerScope = {
  Organization: "organization",
  Self: "self",
  Team: "team",
} as const;
export type AgentSessionViewerScope =
  (typeof AgentSessionViewerScope)[keyof typeof AgentSessionViewerScope];

export const AGENT_SESSION_VIEWER_SCOPE_OPTIONS = [
  AgentSessionViewerScope.Self,
  AgentSessionViewerScope.Organization,
  AgentSessionViewerScope.Team,
] as const;
