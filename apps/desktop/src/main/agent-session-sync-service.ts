import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  AgentSessionSyncMode,
  type SyncedComponent,
  type TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import {
  resolveRepoFullName,
  resolveRepoFullNameAsync,
} from "../server/operations/git-helpers.js";
import {
  type LaunchMetadata,
  readLaunchMetadata,
  readLaunchMetadataAsync,
} from "../server/operations/symphony-utils.js";
import type { BillingMode } from "../shared/billing-mode.js";
import { estimateTokenCost } from "../shared/token-cost.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type AgentSessionSyncBatch,
  type AgentSessionSyncTransportPayload,
  type SyncedAgentSession,
  type SyncedAgentSessionAttribution,
  type SyncJsonObject,
  type SyncJsonValue,
} from "./agent-session-sync-contract.js";
import {
  type AgentSessionPayloadPreparer,
  estimateAgentSessionSyncBatchBytes,
  maxSessionPayloadBytesForBatch,
  prepareAgentSessionPayload,
} from "./agent-session-sync-payload.js";
import type { DesktopSyncBatchEventInput } from "./app-otel-runtime.js";
import { resolveBillingMode } from "./billing-mode-detector.js";
import type { DesktopAgentSessionsAck } from "./cloud-protocol.js";
import { DesktopAgentSessionsAckReason } from "./cloud-protocol.js";
import { gatewayLog } from "./gateway-logger.js";
import { reportTokenCostPricingMiss } from "./token-cost-pricing-miss.js";

const TAG = "agent-session-sync";
const SYNC_INTERVAL_MS = 5000;
const MIN_INCREMENTAL_SYNC_INTERVAL_MS = 30_000;
// Maximum number of candidate session IDs to pull from the queue per sync cycle.
const INCREMENTAL_SESSION_BATCH_SIZE = 10;
// Backfill bound. This is the SINGLE knob that caps how many fully-hydrated
// sessions (each carrying full event `data`) the backfill ever holds in memory
// at once: a sync cycle picks at most this many ids from `backfillQueue`,
// hydrates exactly those, builds + sends their payload, releases them, then the
// next cycle repeats. Peak retained hydration is therefore one batch of this
// size, NOT the whole `backfillQueue` (which is hundreds of ids on a large
// install). Kept deliberately small: the db-host utilityProcess also runs
// SQLite + import, and a single session can carry a multi-MB transcript before
// `sanitizeSessionForSync` strips it, so a small batch keeps the worst-case
// hydration spike bounded and avoids the V8 OOM (exit 5) that a whole-corpus
// load triggered. Larger here only buys marginal throughput at the cost of a
// proportionally larger peak, which is the wrong trade for the OOM-prone host.
export const BACKFILL_SESSION_BATCH_SIZE = 3;

// Maximum serialized JSON payload size per batch (256 KiB).
export const SESSION_PAYLOAD_BYTE_CAP = 262_144;
const SESSION_PAYLOAD_CONTENT_BYTE_CAP = maxSessionPayloadBytesForBatch(
  SESSION_PAYLOAD_BYTE_CAP
);
// After this many consecutive ack timeouts on the same session, dead-letter it
// so one oversized or slow session does not permanently block the queue.
export const MAX_CONSECUTIVE_TIMEOUTS = 3;
// FEA-1461: after this many consecutive `rate_limited` rejections on the same
// session, dead-letter it. Higher than the timeout threshold because
// rate-limits are more legitimately transient (the relay may genuinely just
// be throttling a burst), but still bounded so a persistently-rejected
// session cannot infinite-loop the sync queue + log spam.
export const MAX_CONSECUTIVE_RATE_LIMITED = 5;
// Server-side ingestion failures are payload rejections too. Keep them bounded
// so one bad batch cannot retry forever.
export const MAX_CONSECUTIVE_INGESTION_FAILED = 5;
// FEA-1461: after a `rate_limited` rejection, defer re-attempting the same
// session for this long. Prevents the 5-second sync tick from re-chunking and
// re-sending the same oversized session every cycle (the original symptom).
// Other queued sessions continue to flow through `pickReadyCandidates`.
export const RATE_LIMIT_BACKOFF_MS = 30_000;
export const INGESTION_FAILED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;

export type SessionCursorRow = {
  id: string;
  updated_at: string;
};

export const SessionListCursorSortKey = {
  LastActivity: "lastActivity",
  Started: "started",
} as const;
export type SessionListCursorSortKey =
  (typeof SessionListCursorSortKey)[keyof typeof SessionListCursorSortKey];

export type SessionListCursorPageRequest = {
  limit: number;
  offset: number;
  sortBy: SessionListCursorSortKey;
  sortDir: "asc" | "desc";
  /** Inclusive lower bound for the session activity window, applied before paging. */
  startDate?: Date;
  /** Inclusive upper bound for the session activity window, applied before paging. */
  endDate?: Date;
  /**
   * Free-text list search applied before paging. Implementations should mirror
   * the shared sessions list's identity/branch matching as closely as their
   * local indexes allow.
   */
  search?: string;
};

export type SessionListCursorPage = {
  rows: SessionCursorRow[];
  total: number;
};

type SessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
  metadata: string | null;
  harness: string | null;
  billing_mode: string | null;
  user_id: string | null;
  organization_id: string | null;
};

type TokenUsageRow = {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  created_at?: string | null;
  cost_usd_estimated?: number | null;
};

export type SessionAttributionResolverCache = {
  attributionByCwd: Map<string, SyncedAgentSessionAttribution | null>;
  launchMetadataRootByCwd: Map<string, string | null>;
  repoFullNameByPath: Map<string, string | null>;
};

/**
 * Sanitized filter inputs for the usage aggregation (FEA-1834 / PLN-941 §4).
 * These mirror the session-level predicates of `matchesQuery`/`sanitizeQuery`
 * (harness equality, `started_at` date range, status canonicalization) so the
 * aggregation can apply them in SQL without hydrating sessions.
 */
export type AgentSessionUsageAggregateFilters = {
  harness?: string;
  status?: string;
  /**
   * Multi-status session filter. Takes precedence over `status`, matching the
   * shared list matcher and preventing aggregate endpoints from hydrating the
   * desktop session corpus just to honor multi-select status filters.
   */
  statuses?: string[];
  /**
   * Desktop-local session ownership filter. Explicit user filters match the
   * stored `sessions.user_id`; rows with NULL ownership remain in unfiltered
   * totals and are excluded from explicit user-scoped reads.
   */
  userId?: string;
  /** Multi-user ownership filter. Takes precedence over `userId`. */
  userIds?: string[];
  startDate?: Date;
  endDate?: Date;
};

/**
 * One `(billing_mode, harness, model)` token rollup from the usage aggregation.
 * `billingMode`/`harness`/`model` are the RAW column values (the fold resolves
 * the billing mode and maps null/empty harness/model exactly as the hydrate
 * path does). `sessionCount` is `COUNT(DISTINCT session_id)` within the group.
 */
export type AgentSessionUsageTokenGroup = {
  billingMode: string | null;
  harness: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCount: number;
  estimatedCostUsd: number | null;
};

/**
 * Pre-aggregated usage data — the O(grouped) replacement for hydrating every
 * session to fold a usage summary (FEA-1834 / PLN-941 §4). `tokenGroups` carries
 * SQL SUM/COUNT rollups; `harnessSessionCounts` carries per-harness session
 * counts INCLUDING zero-token sessions (which the token join cannot see, but the
 * hydrate path's `byHarness` includes); `totalSessions` counts all filtered
 * sessions (zero-token included).
 */
export type AgentSessionUsageAggregate = {
  totalSessions: number;
  /** Earliest/latest session start (ISO) across the filtered corpus; null when empty. */
  earliestSessionAt: string | null;
  latestSessionAt: string | null;
  tokenGroups: AgentSessionUsageTokenGroup[];
  harnessSessionCounts: { harness: string | null; sessionCount: number }[];
};

/**
 * One `tool_name` rollup from the analytics aggregation (FEA-2038). Mirrors the
 * hydrate-path `buildToolBreakdowns` fold over the same filtered session set:
 * `invocationCount` counts events with that tool, `errorCount` counts those
 * whose `event_type` matches the error/fail predicate, `sessionCount` is the
 * distinct session count.
 */
export type AgentSessionAnalyticsToolGroup = {
  toolName: string;
  invocationCount: number;
  errorCount: number;
  sessionCount: number;
};

/**
 * One resolved agent-type rollup from the analytics aggregation (FEA-2038).
 * `agentType` is `COALESCE(subagent_type, type, 'unknown')`. `durationTotalMs`/
 * `durationCount` carry the SQL duration fold; the API converts them to
 * `avgDurationMs` and omits these two fields, matching `buildAgentTypeBreakdowns`.
 */
export type AgentSessionAnalyticsAgentTypeGroup = {
  agentType: string;
  count: number;
  successCount: number;
  failedCount: number;
  durationTotalMs: number;
  durationCount: number;
};

/**
 * One per-cwd repository rollup from the analytics aggregation (FEA-2038). SQL
 * groups by the RAW `cwd`; the API resolves each cwd to its attribution and
 * merges cwds that resolve to one `repositoryFullName` (so the field carries the
 * raw cwd here, not the resolved identity).
 */
export type AgentSessionAnalyticsRepositoryGroup = {
  repositoryFullName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCount: number;
};

/**
 * Pre-aggregated analytics data — the O(grouped) replacement for hydrating
 * every filtered session/event/agent/token row to fold the analytics response
 * (FEA-2038, db-host OOM). Folded by `getSharedAgentSessionAnalytics` into the
 * canonical `SharedAgentSessionAnalytics`. `byRepository` carries per-cwd rows
 * keyed by RAW cwd; the API resolves+merges them via the shared attribution cache.
 */
export type AgentSessionAnalyticsAggregate = {
  byTool: AgentSessionAnalyticsToolGroup[];
  byAgentType: AgentSessionAnalyticsAgentTypeGroup[];
  byRepository: AgentSessionAnalyticsRepositoryGroup[];
};

// FEA-1962: the sync kind prefix for a cursor source key. Centralized so the
// service, the sqlite helpers, and tests never re-spell the literal.
export const AGENT_SESSION_SYNC_SOURCE_KIND = "agent_sessions" as const;

// T-8.7: the sync kind prefix for the component inventory sync lane.
export const AGENT_COMPONENT_SYNC_SOURCE_KIND = "agent_components" as const;

/**
 * FEA-1962: the persisted durable cursor for one source key. `observedTopUpdatedAt`
 * is the highest CONTIGUOUS-ACCEPTED watermark (never a discovery-only candidate);
 * `observedIdsAtTopUpdatedAt` are the accepted ids sharing that timestamp so
 * same-timestamp siblings sent later are still selected on restart.
 */
export type PersistedSyncState = {
  observedTopUpdatedAt: string | null;
  observedIdsAtTopUpdatedAt: string[];
};

/**
 * FEA-1962: build the durable cursor key for one authenticated compute target.
 * The cursor is scoped to `computeTargetId` (the server-assigned per-account +
 * machine id) and nothing else: that id is the stable discriminator, so the key
 * only changes when the client genuinely moves to a different machine/account —
 * exactly the case where a one-time full re-backfill is correct. (We do NOT mix
 * org/user into the key: those become known on a different auth path and at a
 * different time than the compute target, so folding them in would change the
 * key mid-session and trigger a spurious re-backfill.)
 */
export function buildAgentSessionSyncSourceKey(
  computeTargetId: string
): string {
  return `${AGENT_SESSION_SYNC_SOURCE_KIND}:${computeTargetId}`;
}

/**
 * T-8.7: build the durable cursor key for the component inventory sync lane.
 * Uses a separate source-kind prefix so its cursor never collides with the
 * session sync cursor for the same compute target.
 */
export function buildAgentComponentSyncSourceKey(
  computeTargetId: string
): string {
  return `${AGENT_COMPONENT_SYNC_SOURCE_KIND}:${computeTargetId}`;
}

/**
 * T-8.7: payload for `POST /desktop/components/sync`. Mirrors the Zod schema
 * in `apps/api/lib/desktop-agent-sessions-schema.ts`; re-exported from the
 * contract file by T-8.8.
 */
export type DesktopAgentComponentsPayload = {
  schemaVersion: 1;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  componentCount: number;
  components: SyncedComponent[];
};

/** Schema version constant for the component inventory sync payload. */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION = 1 as const;

/** Maximum number of components packed per batch sent to the cloud. */
export const AGENT_COMPONENT_BATCH_SIZE = 200 as const;

/**
 * FEA-1962: defensive parse of the JSONB `observed_ids_at_top_updated_at`
 * column (or any untrusted ids value). A malformed value falls back to an
 * empty array so a corrupt row degrades to a full re-discovery, never a throw.
 */
export function parsePersistedObservedIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export type AgentSessionSyncSource = {
  listAllSessionCursorRows(): SessionCursorRow[] | Promise<SessionCursorRow[]>;
  /**
   * Lightweight cursor page for local list views. Unlike sync cursors, this may
   * order by list-specific metadata so the renderer can hydrate only visible
   * rows for default sorted pages instead of loading the full local corpus.
   */
  listSessionCursorPage?(
    request: SessionListCursorPageRequest
  ): SessionListCursorPage | Promise<SessionListCursorPage>;
  /**
   * Cursor rows for the newest `updated_at` group only. Used when startup
   * deliberately defers historical backfill: incremental sync only needs the
   * high-water mark plus tied IDs, not the full session corpus.
   */
  listTopSessionCursorRows?(): SessionCursorRow[] | Promise<SessionCursorRow[]>;
  listUpdatedSessionCursorRows(
    sinceUpdatedAt: string
  ): SessionCursorRow[] | Promise<SessionCursorRow[]>;
  loadSyncedSessions(
    ids: string[],
    cache: SessionAttributionResolverCache,
    // FEA-2038 OOM fix: when `omitEventData` is set the loader skips the heavy
    // per-event `data` JSON blob (events still carry `toolName`/`eventType`).
    // The full-corpus list/analytics reads pass it because they never read
    // `event.data`; the detail/branch callers omit it and keep full event data.
    //
    // FEA-2718: the cloud-sync payload build now ALSO passes `omitEventData`
    // (synced events no longer carry turn text, so hydrating it is pure waste)
    // together with `includeComponentUsage: true` — because component usage
    // (T-8.6) is still emitted on the sync payload and used to be gated on
    // `!omitEventData`. `includeComponentUsage` defaults to `!omitEventData`, so
    // every other caller keeps its current behavior unchanged. Optional so fake
    // test sources keep their current shape.
    options?: { omitEventData?: boolean; includeComponentUsage?: boolean }
  ): SyncedAgentSession[] | Promise<SyncedAgentSession[]>;
  /**
   * Optional lightweight proof that selected sessions cannot fit the existing
   * sync cap even with their events removed. Implementations must only return
   * an ID when the old full hydrate path would also have locally dead-lettered
   * it; unknown or borderline sessions should be omitted and hydrated normally.
   */
  findLocallyOversizedSessions?(
    ids: string[],
    maxBytes: number
  ):
    | { id: string; payloadBytes: number }[]
    | Promise<{ id: string; payloadBytes: number }[]>;
  /**
   * FEA-1834: optional lightweight load for the usage summary — session
   * metadata + tokenUsageByModel only (no agents/events/attribution). Sources
   * without it fall back to the full hydrate path in `getSharedAgentSessionUsage`.
   */
  loadUsageSessions?(
    ids: string[]
  ): SyncedAgentSession[] | Promise<SyncedAgentSession[]>;
  /**
   * FEA-1834 / PLN-941 §4: O(grouped) usage aggregation. Returns SQL SUM/COUNT
   * rollups so the usage summary never hydrates the full corpus on the live
   * refresh cadence. Optional: sources without it (and `ids`-scoped requests)
   * fall back to `loadUsageSessions` / the full hydrate in
   * `getSharedAgentSessionUsage`.
   */
  aggregateUsage?(
    filters: AgentSessionUsageAggregateFilters
  ): AgentSessionUsageAggregate | Promise<AgentSessionUsageAggregate>;
  /**
   * FEA-2038: O(grouped) analytics aggregation. Returns SQL rollups (byTool /
   * byAgentType / byRepository) so the analytics response never hydrates the
   * full session/event/agent/token corpus (the db-host OOM, exit code 5). The
   * per-request attribution `cache` is shared so cwd→repositoryFullName lookups
   * are reused. Optional: sources without it (and `ids`/`search`-scoped requests)
   * fall back to the full hydrate path in `getSharedAgentSessionAnalytics`.
   */
  aggregateAnalytics?(
    filters: AgentSessionUsageAggregateFilters,
    cache: SessionAttributionResolverCache
  ): AgentSessionAnalyticsAggregate | Promise<AgentSessionAnalyticsAggregate>;
  /**
   * FEA-1962: load the persisted durable cursor for `sourceKey`, or `null` when
   * none exists (fresh sqlite / first run after upgrade → full backfill as today).
   * Optional so fake test sources and pre-FEA-1962 sources behave like today.
   */
  loadSyncState?(
    sourceKey: string
  ): PersistedSyncState | null | Promise<PersistedSyncState | null>;
  /**
   * FEA-1962: persist the durable cursor for `sourceKey`. Called ONLY after an
   * accepted ack for a contiguous prefix of rows — never for discovery-only
   * candidates or failed/retryable/dead-lettered rows.
   */
  advanceSyncState?(
    sourceKey: string,
    state: PersistedSyncState
  ): void | Promise<void>;
  loadSessionTokenEvents?(
    sessionId: string
  ): TokenEventCostPoint[] | Promise<TokenEventCostPoint[]>;
  /**
   * T-8.6/Gap B: cursor reader for the component inventory sync lane. Returns
   * rows from `agent_components` ordered by (last_seen_at, id) where
   * last_seen_at >= `since` (or all rows for the initial backfill). Includes
   * tombstoned rows. Optional so fake test sources without it behave like today.
   */
  listComponentCursorRows?(
    since: string
  ): AgentComponentCursorRow[] | Promise<AgentComponentCursorRow[]>;
  /**
   * T-8.6/Gap B: full-row loader for component inventory sync. Returns the
   * `SyncedComponent`-shaped rows for the given component ids.
   */
  loadComponentRows?(
    ids: string[]
  ): SyncedComponent[] | Promise<SyncedComponent[]>;
  close?: () => void | Promise<void>;
};

export type AgentSessionSyncTelemetryEvent = {
  outcome: "failure";
  reason: DesktopAgentSessionsAckReason;
  syncMode: AgentSessionSyncMode;
  sessionCount: number;
  payloadBytes: number;
};

export type AgentSessionSyncServiceOptions = {
  isAgentMonitorEnabled: () => boolean;
  isRelayReady: () => boolean;
  sendBatch: (
    batch: AgentSessionSyncTransportPayload
  ) => Promise<DesktopAgentSessionsAck>;
  /** Live dashboard source for SQLite. */
  getSource?: () => AgentSessionSyncSource | null;
  /**
   * Optional scheduler gate before DB reads, payload shaping, and transport
   * serialization. It must only delay work; sync semantics and payload caps stay
   * owned by this service.
   */
  waitForBackgroundSlot?: () => Promise<void>;
  /**
   * Prepares sanitized, size-checked, and chunked payloads. Production wires a
   * worker-backed implementation so large transcript walks do not run on the
   * Electron main thread; tests default to the in-process pure implementation.
   */
  preparePayloads?: AgentSessionPayloadPreparer;
  onBatchOutcome?: (event: AgentSessionSyncTelemetryEvent) => void;
  /**
   * FEA-1995: per-batch transport-health telemetry sink for the `sync.*`
   * contract schema. Fires on every batch outcome — `success`, `failure`
   * (including a thrown transport error), and `dead_letter` — distinct from
   * `onBatchOutcome`, which is a failure-only product-analytics signal. Routed
   * to the desktop OTel runtime, which owns the `DesktopSyncBatchEventInput`
   * shape (transport health only: counts, bytes, latency, outcome — never
   * session ids or content, per the PRD-468/FEA-1981 guardrail).
   */
  onSyncBatchTelemetry?: (event: DesktopSyncBatchEventInput) => void;
  /**
   * FEA-1962: the authenticated compute target the cursor is scoped to. Returns
   * `null` when none is known yet (offline / pre-hello-ack) → the service runs
   * in-memory-only (full-backfill-on-restart, today's behavior). When the target
   * changes, the in-memory cursor resets and re-hydrates so one compute target
   * never inherits another's persisted watermark.
   */
  getSyncComputeTargetId?: () => string | null;
  /**
   * T-8.7: optional transport for the component inventory sync lane. When
   * provided, each 5s tick also batch-reads updated `agent_components` from the
   * local SQLite store and POSTs them to `POST /desktop/components/sync`.
   * Returns `true` on a successful (2xx) response; `false` on failure (the
   * cursor is NOT advanced on failure so the batch is retried next tick).
   */
  sendComponents?: (payload: DesktopAgentComponentsPayload) => Promise<boolean>;
  /**
   * T-8.7: cursor reader for the component inventory sync lane. Returns rows
   * from `agent_components` ordered by (last_seen_at, id) where last_seen_at
   * >= `since` (or all rows for the initial backfill). Includes tombstoned rows.
   */
  listComponentCursorRows?: (
    since: string
  ) => Promise<AgentComponentCursorRow[]>;
  /**
   * T-8.7: full-row loader for component inventory sync. Returns the
   * `SyncedComponent`-shaped rows for the given component ids.
   */
  loadComponentRows?: (ids: string[]) => Promise<SyncedComponent[]>;
};

/**
 * T-8.7: lightweight cursor row for the component inventory sync lane.
 * Mirrors `SqliteAgentComponentCursorRow` without the database dependency.
 */
export type AgentComponentCursorRow = {
  id: string;
  last_seen_at: string | null;
};

export type AgentSessionSyncStartOptions = {
  /**
   * Queue every known historical session on startup. Boot passes false so the
   * first interactive Desktop window is not competing with a bulk cloud backfill;
   * live sessions are still picked up through the established cursor.
   */
  historicalBackfill?: boolean;
};

/**
 * FEA-2733: a content-blind snapshot of local→cloud sync progress for the
 * renderer "syncing your history" indicator. Counts only — never session ids or
 * content — mirroring the service's telemetry-only outward contract. Read via
 * `getSyncProgress()` and folded into the desktop runtime-status payload.
 */
export type AgentSessionSyncProgress = {
  /** The service is running for an authenticated compute-target identity. */
  identified: boolean;
  /** Historical sessions still queued for the first-connect backfill walk. */
  pendingBackfillSessions: number;
  /** Recently-changed sessions still queued for incremental sync. */
  pendingIncrementalSessions: number;
  /** A bulk historical backfill is currently draining. */
  backfilling: boolean;
  /**
   * The initial cursor enumeration has run for the current identity AND every
   * session-sync queue is drained with no pending parts. Scoped to the session
   * backfill/incremental lanes only: it does NOT reflect the separately-cursored
   * component-inventory lane, and it can be true while `deadLetteredSessions > 0`
   * (sessions dropped after exhausting retries — the renderer surfaces that as
   * "synced with issues" rather than a clean "up to date"). Stays false until the
   * first backfill pass runs, so the indicator never flashes "up to date" before
   * the walk begins.
   */
  caughtUp: boolean;
  /** Sessions dropped after exceeding retry thresholds (surfaced as a warning). */
  deadLetteredSessions: number;
};

export class AgentSessionSyncService {
  private readonly options: AgentSessionSyncServiceOptions;
  private readonly preparePayloads: AgentSessionPayloadPreparer;
  private timer: NodeJS.Timeout | null = null;
  private pendingPartDrainTimer: NodeJS.Timeout | null = null;
  private started = false;
  private syncing = false;
  private historicalBackfillEnabled = true;
  private activeSyncToken: symbol | null = null;
  private sourceStateGeneration = 0;
  private observedTopUpdatedAt: string | null = null;
  private observedIdsAtTopUpdatedAt = new Set<string>();
  /**
   * FEA-2733: whether the initial cursor enumeration has run for the current
   * identity. Distinguishes "not yet started the first-connect walk" (queues
   * transiently empty before the first tick, or an empty local store) from
   * "fully caught up" in `getSyncProgress()`. Reset on identity change.
   */
  private initialBackfillPassRun = false;
  /**
   * FEA-1962: the source key the in-memory cursor was last hydrated for. `null`
   * means "not yet hydrated" (or hydrated for an unknown identity). When the
   * computed source key differs from this, the next sync clears cursor/queue
   * state and re-hydrates from the new key's persisted row.
   */
  private hydratedSourceKey: string | null = null;
  private lastIncrementalBatchAttemptedAtMs = 0;
  private featureDisabledForRelaySession = false;
  private firstAckReceived = false;
  private incrementalQueue: string[] = [];
  private readonly incrementalQueuedIds = new Set<string>();
  private backfillQueue: string[] = [];
  private readonly backfillQueuedIds = new Set<string>();
  private readonly attributionCache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  /** Consecutive timeout count per session ID for dead-letter detection. */
  private readonly timeoutCountById = new Map<string, number>();
  /**
   * FEA-1461: consecutive `rate_limited` count per session ID. Parallel to
   * `timeoutCountById` — kept separate so the existing timeout dead-letter
   * threshold and the new rate-limit threshold do not contaminate each other.
   */
  private readonly rateLimitedCountById = new Map<string, number>();
  /** Consecutive `ingestion_failed` count per session ID. */
  private readonly ingestionFailedCountById = new Map<string, number>();
  /**
   * FEA-1461: per-session deferred-retry deadline (ms since epoch). While the
   * deadline is in the future, `pickReadyCandidates` skips the session.
   */
  private readonly nextRetryAfterMs = new Map<string, number>();
  /** Session IDs removed from the queue after exceeding a retry threshold. */
  private readonly deadLetteredIds = new Set<string>();
  /** Remaining chunks for an oversized session being sent in parts. */
  private pendingChunks: {
    sessionId: string;
    syncMode: AgentSessionSyncMode;
    chunks: SyncedAgentSession[];
  } | null = null;

  // T-8.7: component inventory sync lane state — own cursor, separate from
  // the session sync cursor so the two lanes advance independently.
  /**
   * Cursor watermark for the component inventory sync lane. `null` means not
   * yet initialized; on the first tick all components are read (full backfill).
   */
  private componentSyncWatermark: string | null = null;
  /**
   * The source key the component sync cursor was last loaded for. Follows the
   * same identity-change pattern as `hydratedSourceKey` for sessions.
   */
  private componentSyncHydratedSourceKey: string | null = null;

  constructor(options: AgentSessionSyncServiceOptions) {
    this.options = options;
    this.preparePayloads =
      options.preparePayloads ??
      ((sessions, maxBytes) =>
        Promise.resolve(
          sessions.map((session) =>
            prepareAgentSessionPayload(session, maxBytes)
          )
        ));
  }

  start(options: AgentSessionSyncStartOptions = {}): void {
    if (this.started) {
      return;
    }
    this.historicalBackfillEnabled = options.historicalBackfill ?? true;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    this.clearPendingPartDrainTimer();
    const disposeResult = this.preparePayloads.dispose?.();
    if (disposeResult instanceof Promise) {
      disposeResult.catch(() => undefined);
    }
    this.resetSourceState();
  }

  /**
   * FEA-2733: content-blind snapshot of local→cloud sync progress for the
   * renderer "syncing your history" indicator. Reads in-memory queue state only
   * (no DB access, no ids) so it is cheap to poll on the runtime-status cadence.
   * `caughtUp` is gated on `initialBackfillPassRun` so it never reports "up to
   * date" before the first-connect walk has enumerated local history.
   */
  getSyncProgress(): AgentSessionSyncProgress {
    const pendingBackfillSessions = this.backfillQueue.length;
    const pendingIncrementalSessions = this.incrementalQueue.length;
    const hasPendingParts = this.pendingChunks !== null;
    const sourceKey = this.resolveSyncSourceKey();
    const identified = sourceKey !== null;
    // FEA-2733: the in-memory queue/flag state belongs to `hydratedSourceKey`.
    // Between a compute-target (account) switch and the next sync tick that
    // re-hydrates, the current source key differs from the hydrated one, so the
    // drained queues actually describe the PRIOR identity. Gate `caughtUp` on
    // the keys matching so a freshly-switched target never inherits the old
    // account's "up to date" before its own walk has run.
    const sourceMatchesHydrated =
      identified && sourceKey === this.hydratedSourceKey;
    const queuesDrained =
      pendingBackfillSessions === 0 &&
      pendingIncrementalSessions === 0 &&
      !hasPendingParts;
    return {
      identified,
      pendingBackfillSessions,
      pendingIncrementalSessions,
      backfilling: pendingBackfillSessions > 0,
      caughtUp:
        sourceMatchesHydrated && this.initialBackfillPassRun && queuesDrained,
      deadLetteredSessions: this.deadLetteredIds.size,
    };
  }

  /**
   * Clear every cursor, queue, retry, dead-letter, pending chunk, and
   * attribution cache that is derived from the currently selected dashboard
   * source. Availability disable and source transitions must restart from the
   * next selected source instead of replaying stale work from the prior one.
   */
  resetSourceState(): void {
    this.sourceStateGeneration += 1;
    this.activeSyncToken = null;
    this.syncing = false;
    this.featureDisabledForRelaySession = false;
    this.firstAckReceived = false;
    // FEA-1962: force re-hydration from the persisted cursor on the next sync.
    this.hydratedSourceKey = null;
    this.clearSourceDerivedState();
  }

  /**
   * FEA-1962: clear every cursor/queue/retry/chunk field derived from the
   * current source's rows, WITHOUT bumping the source-state generation or
   * touching relay-session flags. Shared by `resetSourceState` (hard reset) and
   * the hydration path (identity change), so the two cannot drift (DRY).
   */
  private clearSourceDerivedState(): void {
    this.observedTopUpdatedAt = null;
    this.observedIdsAtTopUpdatedAt = new Set<string>();
    this.initialBackfillPassRun = false;
    this.lastIncrementalBatchAttemptedAtMs = 0;
    this.incrementalQueue = [];
    this.incrementalQueuedIds.clear();
    this.backfillQueue = [];
    this.backfillQueuedIds.clear();
    this.attributionCache.attributionByCwd.clear();
    this.attributionCache.launchMetadataRootByCwd.clear();
    this.attributionCache.repoFullNameByPath.clear();
    this.timeoutCountById.clear();
    this.rateLimitedCountById.clear();
    this.ingestionFailedCountById.clear();
    this.nextRetryAfterMs.clear();
    this.deadLetteredIds.clear();
    this.pendingChunks = null;
    this.clearPendingPartDrainTimer();
    // T-8.7: reset component sync cursor so the next tick re-hydrates from
    // the persisted watermark (or performs a full backfill if absent).
    this.componentSyncWatermark = null;
    this.componentSyncHydratedSourceKey = null;
  }

  refresh(): void {
    if (!this.started) {
      return;
    }
    if (!this.options.isRelayReady()) {
      this.featureDisabledForRelaySession = false;
      this.firstAckReceived = false;
      this.lastIncrementalBatchAttemptedAtMs = 0;
    }
    if (!this.shouldRun()) {
      this.clearTimer();
      return;
    }
    this.ensureTimer();
    void this.syncOnce();
  }

  private shouldRun(): boolean {
    // Allow syncing when the relay reports ready via serverCapabilities, or
    // when we have already received a confirmed ack in this relay session
    // (so the service does not rely solely on serverCapabilities.agentSessionSync).
    // The firstAckReceived flag starts false, so initial syncs still proceed
    // via isRelayReady() before any ack is received.
    const relayAccepting = this.options.isRelayReady() || this.firstAckReceived;
    return (
      this.options.isAgentMonitorEnabled() &&
      relayAccepting &&
      !this.featureDisabledForRelaySession
    );
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, SYNC_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private schedulePendingPartDrain(): void {
    if (this.pendingPartDrainTimer || !this.started) {
      return;
    }
    this.pendingPartDrainTimer = setTimeout(() => {
      this.pendingPartDrainTimer = null;
      void this.syncOnce();
    }, 0);
  }

  private clearPendingPartDrainTimer(): void {
    if (!this.pendingPartDrainTimer) {
      return;
    }
    clearTimeout(this.pendingPartDrainTimer);
    this.pendingPartDrainTimer = null;
  }

  /**
   * T-8.7: component inventory sync tick. Runs independently from the session
   * sync on the same 5s interval. Batch-reads updated `agent_components` rows
   * (since the last watermark), packs them into a `DesktopAgentComponentsPayload`,
   * POSTs to `/desktop/components/sync` via `sendComponents`, and advances the
   * persisted cursor on success. Tombstoned rows are included so the cloud
   * receives uninstall signals. Requires `sendComponents`, `listComponentCursorRows`,
   * and `loadComponentRows` to be wired; otherwise this is a no-op.
   */
  private async syncComponentsOnce(): Promise<void> {
    const { sendComponents, listComponentCursorRows, loadComponentRows } =
      this.options;
    if (!(sendComponents && listComponentCursorRows && loadComponentRows)) {
      return;
    }
    const source = this.options.getSource?.() ?? null;
    const computeTargetId = this.options.getSyncComputeTargetId?.() ?? null;
    if (!computeTargetId) {
      return;
    }
    const sourceKey = buildAgentComponentSyncSourceKey(computeTargetId);

    // Hydrate persisted cursor on identity change or first run.
    if (sourceKey !== this.componentSyncHydratedSourceKey) {
      this.componentSyncWatermark = null;
      this.componentSyncHydratedSourceKey = null;
      if (source?.loadSyncState) {
        const persisted = await source.loadSyncState(sourceKey);
        if (persisted?.observedTopUpdatedAt) {
          this.componentSyncWatermark = persisted.observedTopUpdatedAt;
        }
      }
      this.componentSyncHydratedSourceKey = sourceKey;
    }

    // Epoch string → read all rows on first run (full backfill).
    const since = this.componentSyncWatermark ?? "1970-01-01T00:00:00.000Z";
    let cursorRows: AgentComponentCursorRow[];
    try {
      cursorRows = await listComponentCursorRows(since);
    } catch {
      // DB read failure — skip this tick, retry next interval.
      return;
    }
    if (cursorRows.length === 0) {
      return;
    }

    // Cap the batch to AGENT_COMPONENT_BATCH_SIZE.
    const batchRows = cursorRows.slice(0, AGENT_COMPONENT_BATCH_SIZE);
    const batchIds = batchRows.map((r) => r.id);
    let components: SyncedComponent[];
    try {
      components = await loadComponentRows(batchIds);
    } catch {
      return;
    }
    if (components.length === 0) {
      return;
    }

    const payload: DesktopAgentComponentsPayload = {
      schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
      batchId: randomUUID(),
      syncMode: AgentSessionSyncMode.Incremental,
      componentCount: components.length,
      components,
    };

    let accepted = false;
    try {
      accepted = await sendComponents(payload);
    } catch {
      // Transport error — skip cursor advance, retry next tick.
      return;
    }
    if (!accepted) {
      return;
    }

    // Advance cursor to the latest last_seen_at in this batch.
    const newWatermark = batchRows.reduce<string | null>((max, row) => {
      const ts = row.last_seen_at;
      if (!ts) {
        return max;
      }
      return max === null || ts > max ? ts : max;
    }, this.componentSyncWatermark);

    if (newWatermark && newWatermark !== this.componentSyncWatermark) {
      this.componentSyncWatermark = newWatermark;
      if (source?.advanceSyncState) {
        void Promise.resolve(
          source.advanceSyncState(sourceKey, {
            observedTopUpdatedAt: newWatermark,
            observedIdsAtTopUpdatedAt: [],
          })
        ).catch(() => undefined);
      }
    }

    gatewayLog.info(
      TAG,
      `synced ${components.length} agent component(s) to cloud inventory`
    );
  }

  private async syncOnce(): Promise<void> {
    if (this.syncing || !this.shouldRun()) {
      return;
    }
    // T-8.7: run component inventory sync in parallel with the session sync tick.
    void this.syncComponentsOnce();
    const syncToken = Symbol("agent-session-sync");
    const sourceStateGeneration = this.sourceStateGeneration;
    this.activeSyncToken = syncToken;
    this.syncing = true;
    const isCurrentSourceState = () =>
      this.activeSyncToken === syncToken &&
      this.sourceStateGeneration === sourceStateGeneration &&
      this.started &&
      this.shouldRun();

    try {
      await this.options.waitForBackgroundSlot?.();
      if (!isCurrentSourceState()) {
        return;
      }

      const injectedSource = this.options.getSource?.() ?? null;
      if (!injectedSource) {
        return;
      }

      let syncMode: AgentSessionSyncMode | null = null;
      let syncIds: string[] = [];
      let batch: AgentSessionSyncBatch | null = null;
      let accumulatedBytes = 0;

      if (this.pendingChunks && this.pendingChunks.chunks.length > 0) {
        // If there are pending chunks from a previous oversized session split,
        // send the next chunk without touching the DB or queues.
        const { sessionId, syncMode: chunkMode, chunks } = this.pendingChunks;
        const chunk = chunks.shift()!;
        const isLast = chunks.length === 0;
        if (isLast) {
          this.pendingChunks = null;
        }
        batch = {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: randomUUID(),
          syncMode: chunkMode,
          sessionCount: 1,
          sessions: [chunk],
        };
        accumulatedBytes = estimateAgentSessionSyncBatchBytes(batch);
        gatewayLog.info(
          TAG,
          `sending chunked session ${sessionId} (~${formatBytes(accumulatedBytes)}); ` +
            `${chunks.length} chunk(s) remaining`
        );
        syncMode = chunkMode;
        syncIds = [sessionId];
        // Skip DB access — go straight to send.
      } else {
        const source = injectedSource;
        try {
          // FEA-1962: hydrate the persisted cursor BEFORE deciding backfill vs
          // incremental. A hydrated watermark makes initializeBackfillQueueIfNeeded
          // short-circuit (no full re-upload); a fresh/absent row leaves it null
          // → full backfill as today.
          await this.hydratePersistedCursorIfNeeded(source);
          await this.initializeBackfillQueueIfNeeded(source);
          await this.enqueueIncrementalUpdates(source);

          const nowMs = Date.now();
          let candidateIds: string[] = [];
          // FEA-1461: try incremental first. `pickReadyCandidates` may filter
          // out every queued session (all in rate-limit backoff). When that
          // happens, fall through to backfill so it does not get starved
          // for the whole backoff window — previously the early-return
          // below would skip backfill entirely on every tick.
          if (
            this.incrementalQueue.length > 0 &&
            nowMs - this.lastIncrementalBatchAttemptedAtMs >=
              MIN_INCREMENTAL_SYNC_INTERVAL_MS
          ) {
            candidateIds = this.pickReadyCandidates(
              this.incrementalQueue,
              INCREMENTAL_SESSION_BATCH_SIZE,
              nowMs
            );
            if (candidateIds.length > 0) {
              syncMode = AgentSessionSyncMode.Incremental;
              // Only stamp the throttle timestamp if we actually selected
              // at least one ready candidate. Stamping when every candidate
              // was filtered by backoff would unnecessarily delay a session
              // added to the queue moments later by the full
              // MIN_INCREMENTAL_SYNC_INTERVAL_MS window.
              this.lastIncrementalBatchAttemptedAtMs = nowMs;
            }
          }
          if (candidateIds.length === 0 && this.backfillQueue.length > 0) {
            const backfillCandidates = this.pickReadyCandidates(
              this.backfillQueue,
              BACKFILL_SESSION_BATCH_SIZE,
              nowMs
            );
            if (backfillCandidates.length > 0) {
              syncMode = AgentSessionSyncMode.Backfill;
              candidateIds = backfillCandidates;
            }
          }

          if (!syncMode || candidateIds.length === 0) {
            return;
          }

          const hydratableCandidateIds =
            await this.selectHydratableCandidateIds(
              source,
              syncMode,
              candidateIds
            );
          if (hydratableCandidateIds.length === 0) {
            return;
          }

          // Load all candidate sessions from the selected dashboard source,
          // then accumulate into the batch until adding the next session would
          // exceed the 256 KiB cap.
          // Sessions that individually exceed the cap are split into chunks.
          // FEA-2718: hydrate WITHOUT event `data` — the sync payload no longer
          // carries turn text, so loading it only for `sanitizeSessionForSync` to
          // discard it is pure waste and needlessly re-pays the FEA-2038
          // hydration cost. `includeComponentUsage: true` keeps the T-8.6
          // component-usage lane, which previously rode on `!omitEventData`.
          // `let` (not `const`) so this hydration is released for GC once payload
          // preparation no longer needs it (see below).
          let candidateSessions: SyncedAgentSession[] =
            await source.loadSyncedSessions(
              hydratableCandidateIds,
              this.attributionCache,
              { omitEventData: true, includeComponentUsage: true }
            );
          if (!isCurrentSourceState()) {
            return;
          }

          if (candidateSessions.length === 0) {
            this.dequeue(syncMode, hydratableCandidateIds);
            return;
          }

          const sessions: SyncedAgentSession[] = [];
          syncIds = [];
          const batchId = randomUUID();
          const selectedSyncMode = syncMode;
          const buildBatch = (
            batchSessions: SyncedAgentSession[]
          ): AgentSessionSyncBatch => ({
            schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
            batchId,
            syncMode: selectedSyncMode,
            sessionCount: batchSessions.length,
            sessions: batchSessions,
          });
          const preparedPayloads = await this.preparePayloads(
            candidateSessions,
            SESSION_PAYLOAD_CONTENT_BYTE_CAP
          );
          // The prepared payloads are the sanitized copies actually sent; the
          // source hydration is no longer needed. Drop the only reference to it
          // now so it is eligible for GC during the accumulation loop and the
          // subsequent `sendBatch` network round-trip rather than being pinned
          // until `syncOnce` returns. (Since FEA-2718 hydrates without event
          // `data`, this hydration is already slim — the drop still trims the
          // cycle's peak retained memory to just the stripped payloads.)
          candidateSessions = [];
          for (const prepared of preparedPayloads) {
            if (prepared.kind === "dead-letter") {
              if (sessions.length > 0) {
                break;
              }
              this.deadLetterOversizedLocalSession(
                syncMode,
                prepared.sessionId,
                prepared.payloadBytes
              );
              continue;
            }
            if (prepared.kind === "chunked") {
              if (sessions.length > 0) {
                break;
              }
              if (prepared.remainingChunks.length > 0) {
                this.pendingChunks = {
                  sessionId: prepared.sessionId,
                  syncMode,
                  chunks: prepared.remainingChunks,
                };
              }
              const candidateBatch = buildBatch([prepared.firstChunk]);
              const candidateBatchBytes =
                estimateAgentSessionSyncBatchBytes(candidateBatch);
              if (candidateBatchBytes > SESSION_PAYLOAD_BYTE_CAP) {
                this.pendingChunks = null;
                this.deadLetterOversizedLocalSession(
                  syncMode,
                  prepared.sessionId,
                  candidateBatchBytes
                );
                continue;
              }
              sessions.push(prepared.firstChunk);
              syncIds.push(prepared.sessionId);
              accumulatedBytes = candidateBatchBytes;
              gatewayLog.info(
                TAG,
                `chunking oversized session ${prepared.sessionId} (~${formatBytes(prepared.payloadBytes)}) into ` +
                  `${prepared.chunkCount} chunks of <=${formatBytes(SESSION_PAYLOAD_BYTE_CAP)}`
              );
              continue;
            }
            const candidateSessionsForBatch = [...sessions, prepared.session];
            const candidateBatchBytes = estimateAgentSessionSyncBatchBytes(
              buildBatch(candidateSessionsForBatch)
            );
            if (
              sessions.length > 0 &&
              candidateBatchBytes > SESSION_PAYLOAD_BYTE_CAP
            ) {
              break;
            }
            if (candidateBatchBytes > SESSION_PAYLOAD_BYTE_CAP) {
              this.deadLetterOversizedLocalSession(
                syncMode,
                prepared.session.externalSessionId,
                candidateBatchBytes
              );
              continue;
            }
            sessions.push(prepared.session);
            syncIds.push(prepared.session.externalSessionId);
            accumulatedBytes = candidateBatchBytes;
          }
          if (!batch) {
            batch = buildBatch(sessions);
          }
        } finally {
          await source.close?.();
        }
      }

      if (!(batch && syncMode) || syncIds.length === 0) {
        return;
      }
      if (!isCurrentSourceState()) {
        gatewayLog.debug(
          TAG,
          "skipping agent-session sync batch from a stale dashboard source"
        );
        return;
      }

      const sendStartedMs = Date.now();
      let ack: DesktopAgentSessionsAck;
      try {
        ack = await this.options.sendBatch(batch);
      } catch (sendError) {
        // A thrown transport error (socket drop, serialization failure) is
        // itself a batch failure. Emit it so the dashboard counts it instead of
        // silently undercounting — the outer catch only logs. Rethrow so the
        // existing "sync failed" log and finally-block cleanup still run.
        this.options.onSyncBatchTelemetry?.({
          outcome: "failure",
          payloadBytes: accumulatedBytes,
          latencyMs: Math.max(0, Date.now() - sendStartedMs),
        });
        throw sendError;
      }
      // Clamp at 0: a backward wall-clock step (NTP correction, sleep/resume)
      // during the awaited round-trip would otherwise yield a negative latency,
      // which the contract's `sync.latency_ms` (z.number().min(0)) rejects —
      // throwing inside emitSyncBatchEvent and dropping the event. Mirrors the
      // existing Math.max(0, …) duration guard elsewhere in the desktop main.
      const latencyMs = Math.max(0, Date.now() - sendStartedMs);
      if (
        this.activeSyncToken !== syncToken ||
        this.sourceStateGeneration !== sourceStateGeneration ||
        !this.started
      ) {
        gatewayLog.debug(
          TAG,
          "ignoring agent-session batch ack from a stale dashboard source"
        );
        return;
      }
      this.handleBatchAck(
        syncMode,
        syncIds,
        batch.sessionCount,
        accumulatedBytes,
        ack,
        latencyMs
      );
    } catch (error) {
      gatewayLog.warn(
        TAG,
        `sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (this.activeSyncToken === syncToken) {
        this.activeSyncToken = null;
        this.syncing = false;
      }
    }
  }

  // Drop candidates whose SLIM (post-sanitize) payload still can't fit the sync
  // cap; those genuinely can't be synced and are dead-lettered. FEA-2718 removed
  // the separate raw-event-`data` "unhydratable" gate: now that the sync path
  // hydrates with `omitEventData` (never loading event `data`), a session with
  // large local event data but small metadata no longer risks a hydration crash
  // and must NOT be skipped — its slim metadata syncs fine.
  private async selectHydratableCandidateIds(
    source: AgentSessionSyncSource,
    syncMode: AgentSessionSyncMode,
    candidateIds: string[]
  ): Promise<string[]> {
    const oversizedRows =
      (await source.findLocallyOversizedSessions?.(
        candidateIds,
        SESSION_PAYLOAD_CONTENT_BYTE_CAP
      )) ?? [];
    if (oversizedRows.length === 0) {
      return candidateIds;
    }

    const oversizedById = new Map(
      oversizedRows.map((row) => [row.id, row.payloadBytes])
    );
    const hydratableIds: string[] = [];
    for (const id of candidateIds) {
      const payloadBytes = oversizedById.get(id);
      if (payloadBytes === undefined) {
        hydratableIds.push(id);
        continue;
      }
      if (hydratableIds.length > 0) {
        break;
      }
      this.deadLetterOversizedLocalSession(syncMode, id, payloadBytes);
    }
    return hydratableIds;
  }

  private async initializeBackfillQueueIfNeeded(
    source: AgentSessionSyncSource
  ): Promise<void> {
    if (this.observedTopUpdatedAt !== null) {
      // FEA-2733: a cursor is already established for this identity — either a
      // prior tick's walk (which set the flag below) or a persisted cursor that
      // `hydratePersistedCursorIfNeeded` just resumed on an already-synced
      // restart (it sets `observedTopUpdatedAt` and skips this walk). Mark the
      // initial pass complete so a resumed session settles to "up to date"
      // instead of latching on "checking" forever.
      this.initialBackfillPassRun = true;
      return;
    }

    const rows = await this.listInitialCursorRows(source);
    // FEA-2733: the initial enumeration has now run for this identity — even on
    // an empty store (no rows) — so `getSyncProgress()` can report "caught up"
    // rather than latching on a pre-walk "checking" state.
    this.initialBackfillPassRun = true;
    if (rows.length === 0) {
      return;
    }

    this.observedTopUpdatedAt = rows[0].updated_at;
    this.observedIdsAtTopUpdatedAt = collectIdsAtTimestamp(
      rows,
      this.observedTopUpdatedAt
    );
    if (!this.historicalBackfillEnabled) {
      gatewayLog.info(
        TAG,
        `deferred historical backfill; initialized incremental cursor at ${this.observedTopUpdatedAt} with ${this.observedIdsAtTopUpdatedAt.size} top session(s)`
      );
      return;
    }

    for (const row of rows) {
      if (this.backfillQueuedIds.has(row.id)) {
        continue;
      }
      this.backfillQueuedIds.add(row.id);
      this.backfillQueue.push(row.id);
    }

    gatewayLog.info(
      TAG,
      `queued historical backfill for ${rows.length} agent sessions`
    );
  }

  private async listInitialCursorRows(
    source: AgentSessionSyncSource
  ): Promise<SessionCursorRow[]> {
    if (this.historicalBackfillEnabled || !source.listTopSessionCursorRows) {
      return await source.listAllSessionCursorRows();
    }
    return await source.listTopSessionCursorRows();
  }

  private async enqueueIncrementalUpdates(
    source: AgentSessionSyncSource
  ): Promise<void> {
    if (!this.observedTopUpdatedAt) {
      return;
    }

    const previousTopUpdatedAt = this.observedTopUpdatedAt;
    const previousTopIds = new Set(this.observedIdsAtTopUpdatedAt);
    const rows =
      await source.listUpdatedSessionCursorRows(previousTopUpdatedAt);
    if (rows.length === 0) {
      return;
    }

    let nextTopUpdatedAt = previousTopUpdatedAt;
    let nextTopIds = new Set(previousTopIds);
    for (const row of rows) {
      if (row.updated_at > nextTopUpdatedAt) {
        nextTopUpdatedAt = row.updated_at;
        nextTopIds = new Set<string>();
      }
      if (row.updated_at === nextTopUpdatedAt) {
        nextTopIds.add(row.id);
      }
      if (
        row.updated_at === previousTopUpdatedAt &&
        previousTopIds.has(row.id)
      ) {
        continue;
      }
      if (this.incrementalQueuedIds.has(row.id)) {
        continue;
      }
      this.incrementalQueuedIds.add(row.id);
      this.incrementalQueue.push(row.id);
    }

    this.observedTopUpdatedAt = nextTopUpdatedAt;
    this.observedIdsAtTopUpdatedAt = nextTopIds;
  }

  /**
   * FEA-1962: load the persisted cursor for the current principal/target the
   * first time we sync for it (and re-load after an identity change). A present
   * watermark resumes incremental sync from the last uploaded position; an
   * absent one leaves the cursor null so `initializeBackfillQueueIfNeeded`
   * performs a full backfill exactly as before. Runs at most once per identity
   * (guarded by `hydratedSourceKey`) so it never re-queries mid-stream.
   */
  private async hydratePersistedCursorIfNeeded(
    source: AgentSessionSyncSource
  ): Promise<void> {
    const sourceKey = this.resolveSyncSourceKey();
    if (sourceKey === this.hydratedSourceKey) {
      return;
    }
    // Identity changed (account / compute-target switch) or first hydration:
    // drop cursor/queue state derived from a different principal so we never
    // upload the new account's sessions against the old account's watermark.
    if (this.hydratedSourceKey !== null) {
      this.clearSourceDerivedState();
    }
    if (!(sourceKey && source.loadSyncState)) {
      // No identity yet, or a source without persistence → in-memory only,
      // which means today's full-backfill-on-restart behavior. Nothing async
      // can fail here, so mark the identity hydrated immediately.
      this.hydratedSourceKey = sourceKey;
      return;
    }
    // Mark the identity hydrated only AFTER a successful load. If loadSyncState
    // throws (e.g. the sync_state table is transiently unavailable), leaving
    // hydratedSourceKey unchanged lets the next sync tick retry the load instead
    // of the early-return guard permanently wedging the session on a full
    // backfill and ignoring the persisted watermark until restart.
    const persisted = await source.loadSyncState(sourceKey);
    this.hydratedSourceKey = sourceKey;
    if (persisted?.observedTopUpdatedAt) {
      this.observedTopUpdatedAt = persisted.observedTopUpdatedAt;
      this.observedIdsAtTopUpdatedAt = new Set(
        persisted.observedIdsAtTopUpdatedAt
      );
      gatewayLog.info(
        TAG,
        `resumed agent-session sync from persisted cursor (${persisted.observedIdsAtTopUpdatedAt.length} id(s) at top) — skipping full backfill`
      );
    }
  }

  private resolveSyncSourceKey(): string | null {
    const computeTargetId = this.options.getSyncComputeTargetId?.() ?? null;
    return computeTargetId
      ? buildAgentSessionSyncSourceKey(computeTargetId)
      : null;
  }

  /**
   * FEA-1962: persist the durable cursor once the client is fully caught up —
   * both queues drained and no pending chunks. At that moment every row up to
   * `observedTopUpdatedAt` has been accepted, so it is a safe resume point.
   * Persisting only when caught up is the simplest acked-contiguous rule: we
   * never record a watermark ahead of an unaccepted/queued/retrying row, so a
   * restart can never skip a row that was not yet uploaded. Fire-and-forget:
   * a failed write just means the next cold start re-backfills (no data loss).
   *
   * A non-empty dead-letter set also blocks persistence: dead-lettered rows are
   * dropped from the queues but were never accepted, so advancing the watermark
   * past them would permanently lose them on restart. Blocking here forces a
   * cold-start re-backfill instead, which is the safe fallback.
   */
  private persistCursorIfCaughtUp(): void {
    if (
      !this.historicalBackfillEnabled ||
      this.incrementalQueue.length > 0 ||
      this.backfillQueue.length > 0 ||
      this.pendingChunks !== null ||
      this.deadLetteredIds.size > 0
    ) {
      return;
    }
    const sourceKey = this.hydratedSourceKey;
    const source = this.options.getSource?.() ?? null;
    if (!(sourceKey && source?.advanceSyncState && this.observedTopUpdatedAt)) {
      return;
    }
    const state: PersistedSyncState = {
      observedTopUpdatedAt: this.observedTopUpdatedAt,
      observedIdsAtTopUpdatedAt: [...this.observedIdsAtTopUpdatedAt],
    };
    void Promise.resolve(source.advanceSyncState(sourceKey, state)).catch(
      (error) => {
        gatewayLog.warn(
          TAG,
          `failed to persist agent-session sync cursor: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  }

  /**
   * FEA-1461: pick up to `limit` session IDs from `queue`, skipping any whose
   * deferred-retry deadline (set by a prior `rate_limited` failure) is still
   * in the future. Order is preserved for selected IDs so the queue remains
   * stable; only the backed-off entries are skipped, not reordered.
   */
  private pickReadyCandidates(
    queue: readonly string[],
    limit: number,
    nowMs: number
  ): string[] {
    const result: string[] = [];
    for (const id of queue) {
      const deadline = this.nextRetryAfterMs.get(id);
      if (deadline !== undefined && deadline > nowMs) {
        continue;
      }
      result.push(id);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  private handleBatchAck(
    syncMode: AgentSessionSyncMode,
    ids: string[],
    sessionCount: number,
    payloadBytes: number,
    ack: DesktopAgentSessionsAck,
    latencyMs: number
  ): void {
    if (ack.accepted) {
      this.firstAckReceived = true;
      // Only dequeue the session after all chunks have been sent.
      const hasMoreChunks =
        this.pendingChunks !== null &&
        ids.length === 1 &&
        this.pendingChunks.sessionId === ids[0];
      if (!hasMoreChunks) {
        for (const id of ids) {
          this.timeoutCountById.delete(id);
          // FEA-1461: a successful ack resets the rate-limit counter and
          // clears any deferred-retry deadline for this session, so a future
          // rate-limited rejection starts the count over at 1.
          this.rateLimitedCountById.delete(id);
          this.ingestionFailedCountById.delete(id);
          this.nextRetryAfterMs.delete(id);
        }
        this.dequeue(syncMode, ids);
        // FEA-1962: once this dequeue empties both queues the client is fully
        // caught up — persist the watermark so the next cold start resumes here
        // instead of re-uploading the whole local history.
        this.persistCursorIfCaughtUp();
      }
      const deadLetterSuffix =
        this.deadLetteredIds.size > 0
          ? ` deadLettered=${this.deadLetteredIds.size}`
          : "";
      const chunkSuffix = hasMoreChunks
        ? ` (chunk; ${this.pendingChunks!.chunks.length} remaining)`
        : "";
      gatewayLog.info(
        TAG,
        `synced ${sessionCount} agent sessions (${syncMode})${chunkSuffix}; remaining incremental=${this.incrementalQueue.length} backfill=${this.backfillQueue.length}${deadLetterSuffix}`
      );
      if (hasMoreChunks) {
        this.schedulePendingPartDrain();
      }
      this.options.onSyncBatchTelemetry?.({
        outcome: "success",
        payloadBytes,
        latencyMs,
      });
      return;
    }

    // On any failure, discard remaining chunks for this session — partial
    // chunk sequences are not useful without server-side reassembly.
    //
    // FEA-1461: the next retry will re-fetch + re-chunk the source session
    // from the dashboard sync source. That re-chunk work is bounded for transient failures
    // (rate_limited) by the per-session backoff added below — the same
    // session is not re-attempted within RATE_LIMIT_BACKOFF_MS — and by the
    // MAX_CONSECUTIVE_RATE_LIMITED dead-letter trip. True resume-from-chunk-N
    // would eliminate the re-chunk work entirely but requires server-side
    // partial-payload reassembly that does not exist today; tracked as out
    // of scope on FEA-1461.
    if (this.pendingChunks && ids.includes(this.pendingChunks.sessionId)) {
      gatewayLog.warn(
        TAG,
        `discarding ${this.pendingChunks.chunks.length} remaining chunk(s) for session ${this.pendingChunks.sessionId} after batch failure (${ack.reason})`
      );
      this.pendingChunks = null;
    }

    // FEA-1995: a batch is a `dead_letter` for sync.* telemetry when this ack
    // permanently removes one or more sessions — validation_failed drops,
    // ack-timeout trips, and rate-limit trips all grow `deadLetteredIds`.
    // Transient outcomes (retryable timeout, deferred rate-limit, feature
    // disabled, unknown reason) leave the set unchanged and report `failure`.
    const deadLetteredCountBefore = this.deadLetteredIds.size;

    if (ack.reason === DesktopAgentSessionsAckReason.ValidationFailed) {
      gatewayLog.warn(
        TAG,
        `dropping ${ids.length} ${syncMode} agent-session payload(s) after validation_failed to avoid a permanent sync stall`
      );
      this.dequeue(syncMode, ids);
      // FEA-1962: a validation_failed id was never accepted. Treat it as
      // dead-lettered so persistCursorIfCaughtUp — which is blocked while any
      // row is dead-lettered — never records it as accepted; otherwise the
      // persisted watermark would skip it permanently on restart. It stays in
      // observedIdsAtTopUpdatedAt so it is not re-enqueued this session (the
      // existing validation-stall guard), and a cold start re-backfills it.
      for (const id of ids) {
        this.timeoutCountById.delete(id);
        this.rateLimitedCountById.delete(id);
        this.ingestionFailedCountById.delete(id);
        this.nextRetryAfterMs.delete(id);
        this.deadLetteredIds.add(id);
      }
    } else if (ack.reason === DesktopAgentSessionsAckReason.FeatureDisabled) {
      this.featureDisabledForRelaySession = true;
      this.clearTimer();
      gatewayLog.info(
        TAG,
        "pausing agent-session sync until the relay reconnects because the current relay session rejected agent-session batches with feature_disabled"
      );
    } else if (ack.reason === DesktopAgentSessionsAckReason.AckTimeout) {
      const deadLettered: string[] = [];
      for (const id of ids) {
        const count = (this.timeoutCountById.get(id) ?? 0) + 1;
        if (count >= MAX_CONSECUTIVE_TIMEOUTS) {
          deadLettered.push(id);
          this.timeoutCountById.delete(id);
          // FEA-1461: also clear any orphaned rate-limit state for this
          // session so a dead-lettered id leaves no Map entries behind.
          this.rateLimitedCountById.delete(id);
          this.ingestionFailedCountById.delete(id);
          this.nextRetryAfterMs.delete(id);
          this.deadLetteredIds.add(id);
        } else {
          this.timeoutCountById.set(id, count);
        }
      }
      if (deadLettered.length > 0) {
        this.dequeue(syncMode, deadLettered);
        gatewayLog.warn(
          TAG,
          `dead-lettered ${deadLettered.length} oversized/slow agent session(s) after ${MAX_CONSECUTIVE_TIMEOUTS} consecutive ack timeouts ` +
            `(payload ~${formatBytes(payloadBytes)}); ids: ${deadLettered.join(", ")}; ` +
            `remaining incremental=${this.incrementalQueue.length} backfill=${this.backfillQueue.length} deadLettered=${this.deadLetteredIds.size}`
        );
      }
      if (deadLettered.length < ids.length) {
        const attempt =
          this.timeoutCountById.get(
            ids.find((id) => !this.deadLetteredIds.has(id))!
          ) ?? 0;
        gatewayLog.info(
          TAG,
          `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) timed out waiting for server ack ` +
            `(attempt ${attempt}/${MAX_CONSECUTIVE_TIMEOUTS}); batch left queued for retry`
        );
      }
    } else if (ack.reason === DesktopAgentSessionsAckReason.RateLimited) {
      // FEA-1461: previously fell through to the bare `else` below — debug
      // log only, no counter, no dead-letter, no dequeue, no backoff. For an
      // oversized session that's permanently throttled, that produced an
      // infinite retry loop (re-chunking + log spam every 5s).
      //
      // FEA-1461 review fix (PR #258, Codex P1): `cloud-socket.sendAgentSessions`
      // returns `RateLimited` for BOTH server-side payload throttling AND
      // local transport unavailability (`!isRelayReady()` or socket
      // disconnected after the batch was prepared). Treating a relay flap
      // as a session-payload problem would dead-letter perfectly good
      // sessions after 5 disconnects. Re-check relay readiness here: if the
      // relay is down right now, the ack came from the transport layer —
      // defer with backoff but do NOT increment the dead-letter counter.
      const relayHealthy = this.options.isRelayReady();
      const deadLettered: string[] = [];
      const deferred: string[] = [];
      const retryDeadline = Date.now() + RATE_LIMIT_BACKOFF_MS;
      for (const id of ids) {
        const previousCount = this.rateLimitedCountById.get(id) ?? 0;
        const count = relayHealthy ? previousCount + 1 : previousCount;
        if (relayHealthy && count >= MAX_CONSECUTIVE_RATE_LIMITED) {
          deadLettered.push(id);
          this.rateLimitedCountById.delete(id);
          this.nextRetryAfterMs.delete(id);
          // FEA-1461: also clear any orphaned timeout state for this
          // session so a dead-lettered id leaves no Map entries behind.
          this.timeoutCountById.delete(id);
          this.ingestionFailedCountById.delete(id);
          this.deadLetteredIds.add(id);
        } else {
          if (relayHealthy) {
            this.rateLimitedCountById.set(id, count);
          }
          this.nextRetryAfterMs.set(id, retryDeadline);
          deferred.push(id);
        }
      }
      if (deadLettered.length > 0) {
        this.dequeue(syncMode, deadLettered);
        gatewayLog.warn(
          TAG,
          `dead-lettered ${deadLettered.length} agent session(s) after ${MAX_CONSECUTIVE_RATE_LIMITED} consecutive rate_limited rejections ` +
            `(payload ~${formatBytes(payloadBytes)}); ids: ${deadLettered.join(", ")}; ` +
            `remaining incremental=${this.incrementalQueue.length} backfill=${this.backfillQueue.length} deadLettered=${this.deadLetteredIds.size}`
        );
      }
      if (deferred.length > 0) {
        const sampleId = deferred[0];
        const attempt = this.rateLimitedCountById.get(sampleId) ?? 0;
        gatewayLog.info(
          TAG,
          `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) rate_limited ` +
            `(${relayHealthy ? "server payload throttle" : "transport unavailable"}); ` +
            `deferring ${deferred.length} session(s) for ${Math.round(RATE_LIMIT_BACKOFF_MS / 1000)}s ` +
            `(attempt ${attempt}/${MAX_CONSECUTIVE_RATE_LIMITED}); batch left queued for retry`
        );
      }
    } else if (ack.reason === DesktopAgentSessionsAckReason.IngestionFailed) {
      const deadLettered: string[] = [];
      const deferred: string[] = [];
      const retryDeadline = Date.now() + INGESTION_FAILED_BACKOFF_MS;
      for (const id of ids) {
        const count = (this.ingestionFailedCountById.get(id) ?? 0) + 1;
        if (count >= MAX_CONSECUTIVE_INGESTION_FAILED) {
          deadLettered.push(id);
          this.ingestionFailedCountById.delete(id);
          this.nextRetryAfterMs.delete(id);
          this.timeoutCountById.delete(id);
          this.rateLimitedCountById.delete(id);
          this.deadLetteredIds.add(id);
        } else {
          this.ingestionFailedCountById.set(id, count);
          this.nextRetryAfterMs.set(id, retryDeadline);
          deferred.push(id);
        }
      }
      if (deadLettered.length > 0) {
        this.dequeue(syncMode, deadLettered);
        gatewayLog.warn(
          TAG,
          `dead-lettered ${deadLettered.length} agent session(s) after ${MAX_CONSECUTIVE_INGESTION_FAILED} consecutive ingestion_failed rejections ` +
            `(payload ~${formatBytes(payloadBytes)}); ids: ${deadLettered.join(", ")}; ` +
            `remaining incremental=${this.incrementalQueue.length} backfill=${this.backfillQueue.length} deadLettered=${this.deadLetteredIds.size}`
        );
      }
      if (deferred.length > 0) {
        const sampleId = deferred[0];
        const attempt = this.ingestionFailedCountById.get(sampleId) ?? 0;
        gatewayLog.info(
          TAG,
          `agent-session batch (${syncMode}, ~${formatBytes(payloadBytes)}) ingestion_failed; ` +
            `deferring ${deferred.length} session(s) for ${Math.round(INGESTION_FAILED_BACKOFF_MS / 1000)}s ` +
            `(attempt ${attempt}/${MAX_CONSECUTIVE_INGESTION_FAILED}); batch left queued for retry`
        );
      }
    } else {
      gatewayLog.debug(
        TAG,
        `agent-session batch rejected by server (${syncMode}): ${ack.reason}`
      );
    }

    this.options.onBatchOutcome?.({
      outcome: "failure",
      reason: ack.reason,
      syncMode,
      sessionCount,
      payloadBytes,
    });
    this.options.onSyncBatchTelemetry?.({
      outcome:
        this.deadLetteredIds.size > deadLetteredCountBefore
          ? "dead_letter"
          : "failure",
      payloadBytes,
      latencyMs,
    });
  }

  private clearFailureStateForId(id: string): void {
    this.timeoutCountById.delete(id);
    this.rateLimitedCountById.delete(id);
    this.ingestionFailedCountById.delete(id);
    this.nextRetryAfterMs.delete(id);
  }

  private deadLetterOversizedLocalSession(
    syncMode: AgentSessionSyncMode,
    sessionId: string,
    payloadBytes: number
  ): void {
    this.clearFailureStateForId(sessionId);
    this.deadLetteredIds.add(sessionId);
    this.dequeue(syncMode, [sessionId]);
    gatewayLog.warn(
      TAG,
      "dead-lettered 1 locally oversized agent session before cloud sync " +
        `(payload ~${formatBytes(payloadBytes)} exceeds ${formatBytes(SESSION_PAYLOAD_BYTE_CAP)} after chunking); ` +
        `ids: ${sessionId}; remaining incremental=${this.incrementalQueue.length} backfill=${this.backfillQueue.length} ` +
        `deadLettered=${this.deadLetteredIds.size}`
    );
    // FEA-1995: the >256 KiB permanent-stall wedge the PRD-482 dashboard exists
    // to surface. No `latencyMs` — the session is dropped before any send.
    this.options.onSyncBatchTelemetry?.({
      outcome: "dead_letter",
      payloadBytes,
    });
  }

  private dequeue(syncMode: AgentSessionSyncMode, ids: string[]): void {
    const removeIds = new Set(ids);
    if (syncMode === AgentSessionSyncMode.Incremental) {
      this.incrementalQueue = this.incrementalQueue.filter(
        (id) => !removeIds.has(id)
      );
      for (const id of removeIds) {
        this.incrementalQueuedIds.delete(id);
      }
      return;
    }

    this.backfillQueue = this.backfillQueue.filter((id) => !removeIds.has(id));
    for (const id of removeIds) {
      this.backfillQueuedIds.delete(id);
    }
  }
}

function collectIdsAtTimestamp(
  rows: SessionCursorRow[],
  updatedAt: string
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.updated_at !== updatedAt) {
      break;
    }
    ids.add(row.id);
  }
  return ids;
}

export function resolveStoredTokenUsageCostUsd(
  tokenUsage: TokenUsageRow
): number | undefined {
  return tokenUsage.cost_usd_estimated == null
    ? undefined
    : Number(tokenUsage.cost_usd_estimated);
}

export function resolveTokenUsageCostUsd(
  tokenUsage: TokenUsageRow
): number | undefined {
  const storedCostUsd = resolveStoredTokenUsageCostUsd(tokenUsage);
  if (storedCostUsd !== undefined) {
    return storedCostUsd;
  }
  const costInput = {
    model: tokenUsage.model,
    inputTokens: tokenUsage.input_tokens,
    outputTokens: tokenUsage.output_tokens,
    cacheReadTokens: tokenUsage.cache_read_tokens,
    cacheWriteTokens: tokenUsage.cache_write_tokens,
    observedAt: tokenUsage.created_at,
  };
  const estimate = estimateTokenCost(costInput);
  if (!estimate) {
    reportTokenCostPricingMiss(
      costInput,
      "sync_resolver",
      tokenUsage.session_id
    );
    return undefined;
  }
  return estimate.costUsd;
}

/**
 * Resolve a session's billing mode for the sync payload (CLOSEDLOOP FEA-1434).
 * The sidecar importers and the Claude session route stamp the real mode at
 * ingest; this fills the gap for legacy rows (migrated to the default
 * 'unknown') by best-effort detecting from the live desktop environment. A
 * stored, definite mode always wins over re-detection.
 */
export function resolveBillingModeForRow(
  row: Pick<SessionRow, "billing_mode" | "harness">
): BillingMode {
  return resolveBillingMode({
    billingMode: row.billing_mode,
    harness: row.harness,
  });
}

export function resolveSessionAttribution(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): SyncedAgentSessionAttribution | undefined {
  if (!cwd) {
    return undefined;
  }

  const cached = cache.attributionByCwd.get(cwd);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const worktreePath =
    findLaunchMetadataRoot(cwd, cache.launchMetadataRootByCwd) ?? cwd;
  const launchMetadata = readLaunchMetadata(worktreePath);
  const repoLookupPath = worktreePath;
  let repositoryFullName = cache.repoFullNameByPath.get(repoLookupPath);
  if (repositoryFullName === undefined) {
    repositoryFullName = resolveRepoFullName(repoLookupPath);
    cache.repoFullNameByPath.set(repoLookupPath, repositoryFullName);
  }

  const attribution = buildAttribution(
    worktreePath,
    repositoryFullName ?? null,
    launchMetadata
  );
  cache.attributionByCwd.set(cwd, attribution ?? null);
  return attribution ?? undefined;
}

/**
 * Async attribution resolver for sync hydration. It preserves
 * `resolveSessionAttribution` output and cache semantics while moving launch
 * metadata reads and git remote lookup off the Electron main thread.
 */
export async function resolveSessionAttributionAsync(
  cwd: string | null,
  cache: SessionAttributionResolverCache
): Promise<SyncedAgentSessionAttribution | undefined> {
  if (!cwd) {
    return undefined;
  }

  const cached = cache.attributionByCwd.get(cwd);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const worktreePath =
    (await findLaunchMetadataRootAsync(cwd, cache.launchMetadataRootByCwd)) ??
    cwd;
  const launchMetadata = await readLaunchMetadataAsync(worktreePath);
  const repoLookupPath = worktreePath;
  let repositoryFullName = cache.repoFullNameByPath.get(repoLookupPath);
  if (repositoryFullName === undefined) {
    repositoryFullName = await resolveRepoFullNameAsync(repoLookupPath);
    cache.repoFullNameByPath.set(repoLookupPath, repositoryFullName);
  }

  const attribution = buildAttribution(
    worktreePath,
    repositoryFullName ?? null,
    launchMetadata
  );
  cache.attributionByCwd.set(cwd, attribution ?? null);
  return attribution ?? undefined;
}

function buildAttribution(
  worktreePath: string,
  repositoryFullName: string | null,
  launchMetadata: LaunchMetadata | null
): SyncedAgentSessionAttribution | null {
  const attribution: SyncedAgentSessionAttribution = {
    repositoryFullName,
    worktreePath,
    sourceArtifactId: launchMetadata?.artifactId ?? null,
    sourceLoopId: launchMetadata?.loopId ?? null,
    baseBranch: launchMetadata?.baseBranch ?? null,
  };

  return Object.values(attribution).some((value) => value) ? attribution : null;
}

function findLaunchMetadataRoot(
  startDir: string,
  cache: Map<string, string | null>
): string | null {
  const cached = cache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }

  let currentDir = startDir;
  while (true) {
    const metadataPath = path.join(
      currentDir,
      ".closedloop-ai",
      "work",
      "launch-metadata.json"
    );
    if (existsSync(metadataPath)) {
      cache.set(startDir, currentDir);
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      cache.set(startDir, null);
      return null;
    }
    currentDir = parentDir;
  }
}

async function findLaunchMetadataRootAsync(
  startDir: string,
  cache: Map<string, string | null>
): Promise<string | null> {
  const cached = cache.get(startDir);
  if (cached !== undefined) {
    return cached;
  }

  let currentDir = startDir;
  while (true) {
    const metadataPath = path.join(
      currentDir,
      ".closedloop-ai",
      "work",
      "launch-metadata.json"
    );
    if (await fileExists(metadataPath)) {
      cache.set(startDir, currentDir);
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      cache.set(startDir, null);
      return null;
    }
    currentDir = parentDir;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function parseJsonValueText(value: string | null): SyncJsonValue | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return toSyncJsonValue(JSON.parse(value));
  } catch {
    return toSyncJsonValue(value);
  }
}

export function parseJsonObjectText(
  value: string | null
): SyncJsonObject | null {
  const parsed = parseJsonValueText(value);
  return isSyncJsonObject(parsed) ? parsed : null;
}

function toSyncJsonValue(value: unknown): SyncJsonValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toSyncJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: SyncJsonObject = {};
    for (const [key, entry] of Object.entries(record)) {
      const parsed = toSyncJsonValue(entry);
      if (parsed !== null) {
        normalized[key] = parsed;
      }
    }
    return normalized;
  }
  return null;
}

function isSyncJsonObject(
  value: SyncJsonValue | null
): value is SyncJsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
