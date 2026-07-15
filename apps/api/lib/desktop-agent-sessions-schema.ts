import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/api/src/session-trace/derivation";
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION as API_AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT as API_DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  AgentSessionSyncMode as ApiAgentSessionSyncMode,
  DesktopAgentSessionsAckReason as ApiDesktopAgentSessionsAckReason,
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import {
  isKnownArtifactRefKind,
  MAX_SYNCED_ARTIFACT_REFS,
  MAX_SYNCED_SESSION_PR_REFS,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import { z } from "zod";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
} from "./agent-sessions-text-sanitizer";
import { jsonObjectSchema } from "./json-schema";

export type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";

export const DESKTOP_AGENT_SESSIONS_SOCKET_EVENT =
  API_DESKTOP_AGENT_SESSIONS_SOCKET_EVENT;
export const DesktopAgentSessionsAckReason = ApiDesktopAgentSessionsAckReason;
export const AGENT_SESSION_SYNC_SCHEMA_VERSION =
  API_AGENT_SESSION_SYNC_SCHEMA_VERSION;

const syncModeValues = Object.values(ApiAgentSessionSyncMode) as [
  (typeof ApiAgentSessionSyncMode)[keyof typeof ApiAgentSessionSyncMode],
  ...(typeof ApiAgentSessionSyncMode)[keyof typeof ApiAgentSessionSyncMode][],
];

// ---------------------------------------------------------------------------
// T-7.7: Component inventory sync schema version
// ---------------------------------------------------------------------------

/** Schema version for the desktop → cloud component inventory sync payload. */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION = 1 as const;

/**
 * Maximum number of `SyncedComponentUsage` entries allowed per session payload.
 * Mirrors the `MAX_SYNCED_ARTIFACT_REFS` pattern to prevent oversized batches.
 */
export const MAX_SYNCED_COMPONENT_USAGE = 500 as const;

const isoDateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );

const nullableTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

const optionalPreservedTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

const optionalJsonObjectSchema = z
  .unknown()
  .pipe(jsonObjectSchema)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

// ---------------------------------------------------------------------------
// T-7.7: Zod schemas for component inventory sync (SyncedComponent) and
// per-session component usage (SyncedComponentUsage).
// ---------------------------------------------------------------------------

/**
 * Mirrors `SyncedComponent` from `packages/api/src/types/agent-session.ts`.
 * Used by `desktopAgentComponentsPayloadSchema` for `POST /desktop/components/sync`.
 */
export const syncedComponentSchema = z.object({
  externalId: z.string().trim().min(1),
  componentKind: z.string().trim().min(1),
  harness: nullableTrimmedStringSchema,
  name: nullableTrimmedStringSchema,
  componentKey: nullableTrimmedStringSchema,
  version: nullableTrimmedStringSchema,
  description: nullableTrimmedStringSchema,
  sourceUrl: nullableTrimmedStringSchema,
  installPath: nullableTrimmedStringSchema,
  packId: nullableTrimmedStringSchema,
  scope: nullableTrimmedStringSchema,
  projectPath: nullableTrimmedStringSchema,
  metadata: optionalJsonObjectSchema,
  firstSeenAt: isoDateSchema.nullable().optional(),
  lastSeenAt: isoDateSchema.nullable().optional(),
  uninstalledAt: isoDateSchema.nullable().optional(),
});

/**
 * Payload schema for `POST /desktop/components/sync`.
 * Carries a batch of inventory existence rows for a single compute target.
 */
export const desktopAgentComponentsPayloadSchema = z.object({
  schemaVersion: z.literal(AGENT_COMPONENT_SYNC_SCHEMA_VERSION),
  batchId: z.string().uuid(),
  syncMode: z.enum(syncModeValues),
  componentCount: z.number().int().nonnegative(),
  components: z.array(syncedComponentSchema).max(200),
});

export type DesktopAgentComponentsPayload = z.infer<
  typeof desktopAgentComponentsPayloadSchema
>;

/**
 * Mirrors `SyncedComponentUsage` from `packages/api/src/types/agent-session.ts`.
 * Carried in `SyncedAgentSession.components[]` on the session sync payload.
 */
export const syncedComponentUsageSchema = z.object({
  componentKind: z.string().trim().min(1),
  componentKey: z.string().trim().min(1),
  externalComponentId: nullableTrimmedStringSchema,
  harness: nullableTrimmedStringSchema,
  invocations: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  firstInvokedAt: isoDateSchema.nullable().optional(),
  lastInvokedAt: isoDateSchema.nullable().optional(),
  // FEA-2990: per-event git branch attribution. Additive/optional — omission
  // (older desktop builds) or null means "no per-event branch", so the cloud
  // falls back to session-level SessionBranch attribution and previously synced
  // rows are never cleared.
  gitBranch: nullableTrimmedStringSchema,
});

// Token counts cross the wire as JSON numbers, deliberately kept within the
// 2^53 safe-integer envelope rather than stringified: the desktop preserves the
// same ceiling and the cloud stores them in BigInt (int8) columns, so a session
// that exceeds the old int4 limit (2,147,483,647) carries through without
// truncation or precision loss. See the BigInt-carry regression in
// app/desktop/agent-sessions/sync/route.integration.test.ts (FEA-2728).
const syncedAgentSessionTokenUsageSchema = z.object({
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
});

// FEA-2730 (G1): raw per-event token rows. Same 2^53 numeric envelope as
// tokenUsageByModel above (land in BigInt columns). `externalEventId` is the
// desktop's content hash of the row — the idempotency key for re-sync.
const syncedAgentSessionTokenEventSchema = z.object({
  externalEventId: z.string().trim().min(1),
  agentExternalId: nullableTrimmedStringSchema,
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  createdAt: isoDateSchema,
});

// FEA-2730 (G10): the desktop per-session analytics rollup, synced as-is. Token
// counts share the same 2^53 envelope; `startedDay` is a "YYYY-MM-DD" bucket
// string (not a full timestamp).
const syncedAgentSessionAnalyticsSchema = z.object({
  startedAt: isoDateSchema.nullable().optional(),
  startedDay: nullableTrimmedStringSchema,
  status: nullableTrimmedStringSchema,
  harness: nullableTrimmedStringSchema,
  isHuman: z.boolean(),
  humanTurns: z.number().int().nonnegative(),
  agentTurns: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  toolInvocations: z.number().int().nonnegative(),
  errorEvents: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  runtimeMs: z.number().int().nonnegative().nullable().optional(),
  updatedAt: isoDateSchema.nullable().optional(),
});

export const sessionPrSchema = z.object({
  num: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
  title: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(64),
});

export const activityBucketSchema = z.object({
  label: z.string().trim().min(1).max(80),
  cIn: z.number().finite().nonnegative(),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  total: z.number().int().nonnegative(),
  toolStart: z.number().int().nonnegative(),
  tl0: z.number().int().nonnegative().nullable(),
  byModel: z.record(
    z.string().trim().min(1).max(120),
    z.object({
      cIn: z.number().finite().nonnegative(),
      cOut: z.number().finite().nonnegative(),
      cCache: z.number().finite().nonnegative(),
    })
  ),
});

export const sessionSpanSchema = z.object({
  first: z.string().trim().min(1).max(80),
  last: z.string().trim().min(1).max(80),
});

export const sessionMarkerSchema = z.object({
  kind: z.enum(["commit", "pr", "fail", "frust", "prompt"]),
  x: z.number().finite().min(0).max(100),
  t: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(SESSION_TRACE_SOURCE_LIMITS.markerLabel),
  tl: z.number().int().nonnegative(),
  illustrative: z.boolean().optional(),
});

export const sessionThrottleSchema = z.object({
  x0: z.number().finite().min(0).max(100),
  t0: z.string().trim().min(1).max(80),
  t1: z.string().trim().min(1).max(80),
  durMin: z.number().finite().nonnegative(),
  tl: z.number().int().nonnegative(),
});

export const sessionTracePhaseSourceSchema = z.object({
  sourceType: z.enum(SessionTracePhaseSourceType),
  phaseKey: z
    .string()
    .trim()
    .min(1)
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText),
  label: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  startedAt: isoDateSchema,
  endedAt: isoDateSchema.nullish(),
});

export const sessionTraceThrottleSourceSchema = z.object({
  sourceType: z.enum(SessionTraceThrottleSourceType),
  provider: z
    .string()
    .trim()
    .min(1)
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText),
  observedAt: isoDateSchema,
  limitKind: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  statusCode: z.number().int().min(100).max(599).nullish(),
  errorCode: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  resetAt: isoDateSchema.nullish(),
  retryAfterSeconds: z.number().finite().nonnegative().nullish(),
});

export const sessionTraceCorrectionSourceSchema = z.object({
  kind: z.enum(SessionTraceCorrectionSourceKind),
  observedAt: isoDateSchema,
  label: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
  sourceType: z
    .string()
    .trim()
    .max(SESSION_TRACE_SOURCE_LIMITS.sourceText)
    .nullish(),
});

export const sessionPhaseSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  dur: z.string().trim().min(1).max(80),
  cost: z.string().trim().min(1).max(80),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  cIn: z.number().finite().nonnegative(),
});

export const phaseLoopbackSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  depth: z.number().finite().nonnegative(),
});

export const syncedAgentSessionAgentSchema = z.object({
  externalAgentId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  subagentType: nullableTrimmedStringSchema,
  status: z.string().trim().min(1),
  task: nullableTrimmedStringSchema,
  currentTool: nullableTrimmedStringSchema,
  startedAt: isoDateSchema.nullable().optional(),
  updatedAt: isoDateSchema.nullable().optional(),
  endedAt: isoDateSchema.nullable().optional(),
  awaitingInputSince: isoDateSchema.nullable().optional(),
  parentExternalAgentId: nullableTrimmedStringSchema,
  metadata: optionalJsonObjectSchema,
});

// FEA-2718: synced events carry only columnar metadata. Conversation turn text
// (`summary`/`data`) is gone from the wire and the DB — the cloud transcript
// (FEA-2717) is the sole source of turn/tool detail. A stale desktop still on
// the pre-FEA-2718 shape does NOT reach this schema: the batch schema pins
// `schemaVersion` to the literal 2 (see `AGENT_SESSION_SYNC_SCHEMA_VERSION` in
// `@repo/api`), so a v1 payload is rejected outright first. This event schema's
// omission of `summary`/`data` is therefore defense-in-depth — if a v2 payload
// still carries them, `z.object` drops the unknown keys so turn text can never
// be persisted.
export const syncedAgentSessionEventSchema = z.object({
  externalEventId: z.string().trim().min(1),
  agentExternalId: nullableTrimmedStringSchema,
  eventType: z.string().trim().min(1),
  toolName: nullableTrimmedStringSchema,
  createdAt: isoDateSchema,
});

const syncedAgentSessionAttributionSchema = z
  .object({
    repositoryFullName: nullableTrimmedStringSchema,
    worktreePath: nullableTrimmedStringSchema,
    sourceArtifactId: nullableTrimmedStringSchema,
    sourceLoopId: nullableTrimmedStringSchema,
    baseBranch: nullableTrimmedStringSchema,
  })
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const syncedAgentSessionSchema = z.object({
  externalSessionId: z.string().trim().min(1),
  name: nullableTrimmedStringSchema,
  status: z.string().trim().min(1),
  // Per-session billing mode the desktop resolves from its local billing_mode
  // column (e.g. "api", "pro", "subscription_unknown"). Accepted opaquely and
  // additive — older desktop builds omit it. The usage cost split uses it to
  // classify DESKTOP_SYNC sessions that have no source Loop.
  billingMode: z.string().trim().min(1).max(64).nullish(),
  harness: nullableTrimmedStringSchema,
  cwd: nullableTrimmedStringSchema,
  model: nullableTrimmedStringSchema,
  startedAt: isoDateSchema,
  updatedAt: isoDateSchema,
  endedAt: isoDateSchema.nullable().optional(),
  awaitingInputSince: isoDateSchema.nullable().optional(),
  metadata: optionalJsonObjectSchema,
  attribution: syncedAgentSessionAttributionSchema,
  /** FEA-1459: device IANA timezone for timezone-aware day attribution. */
  deviceTimeZone: z.string().min(1).max(64).nullish(),
  branch: optionalPreservedTrimmedStringSchema,
  prs: z.array(sessionPrSchema).max(MAX_SYNCED_SESSION_PR_REFS).nullish(),
  wallClock: optionalPreservedTrimmedStringSchema,
  activeAgent: optionalPreservedTrimmedStringSchema,
  waitingUser: optionalPreservedTrimmedStringSchema,
  linesAdded: z.number().int().nonnegative().nullable().optional(),
  linesRemoved: z.number().int().nonnegative().nullable().optional(),
  filesChanged: z.number().int().nonnegative().nullable().optional(),
  gitDiffStats: z
    .object({
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      filesChanged: z.number().int().nonnegative(),
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  branchDiffStats: z
    .object({
      linesAdded: z.number().int().nonnegative(),
      linesRemoved: z.number().int().nonnegative(),
      filesChanged: z.number().int().nonnegative(),
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  turns: z.number().int().nonnegative().nullable().optional(),
  steeringEpisodes: z.number().int().nonnegative().nullable().optional(),
  autonomy: z.number().int().min(0).max(100).nullable().optional(),
  activityBuckets: z.array(activityBucketSchema).max(500).nullish(),
  span: sessionSpanSchema.nullish(),
  markers: z
    .array(sessionMarkerSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.markers)
    .nullish(),
  throttles: z.array(sessionThrottleSchema).max(100).nullish(),
  tracePhaseSources: z
    .array(sessionTracePhaseSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.phaseSources)
    .nullish(),
  throttleSources: z
    .array(sessionTraceThrottleSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.throttleSources)
    .nullish(),
  correctionSources: z
    .array(sessionTraceCorrectionSourceSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.correctionSources)
    .nullish(),
  // FEA-2563: cap at the same limit as `tracePhaseSources`. `phases` (distinct
  // keys) and `phaseLoopbacks` are derived from `phaseSources` (sliced to
  // `phaseSources` on the desktop), so their counts are bounded by that source
  // limit. A tighter `.max(50)` here rejected — and thus dropped the entire
  // batch of up to 200 sessions — for phase-cycling sessions with >50 distinct
  // phases or loopbacks. Widening (never narrowing) is deploy-safe because the
  // cloud ships ahead of desktop.
  phases: z
    .array(sessionPhaseSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.phaseSources)
    .nullish(),
  phaseIterations: z.record(z.string(), z.number().int().positive()).nullish(),
  phaseLoopbacks: z
    .array(phaseLoopbackSchema)
    .max(SESSION_TRACE_SOURCE_LIMITS.phaseSources)
    .nullish(),
  dataRevision: z.number().int().min(1).nullish(),
  // Forward compat (FEA-2729): a ref whose explicit `kind` is unknown to this
  // contract version is dropped rather than failing the whole payload. Legacy
  // refs (no `kind`) and known kinds still undergo strict validation — so an
  // invalid slug on a known kind is still rejected.
  artifactRefs: z
    .preprocess((value) => {
      if (!Array.isArray(value)) {
        return value;
      }
      // Bound the RAW array before dropping unknown kinds so a client can't
      // smuggle an oversized array past `.max()` by padding it with
      // unknown-kind entries — let the array validator reject it.
      if (value.length > MAX_SYNCED_ARTIFACT_REFS) {
        return value;
      }
      const known = value.filter((entry) => {
        if (entry !== null && typeof entry === "object" && "kind" in entry) {
          return isKnownArtifactRefKind((entry as { kind: unknown }).kind);
        }
        return true;
      });
      // If every entry was an unknown kind, treat as "no refs sent" (undefined)
      // rather than an explicit empty array. An explicit `[]` means "this
      // session references nothing → remove existing links", which must never
      // be inferred from a forward-compat drop.
      if (value.length > 0 && known.length === 0) {
        return undefined;
      }
      return known;
      // Inner `.optional()` lets the all-unknown → undefined path validate; the
      // outer `.optional()` keeps the field itself omittable.
    }, z
      .array(syncedArtifactRefSchema)
      .max(MAX_SYNCED_ARTIFACT_REFS)
      .optional())
    .optional(),
  prRefs: z
    .array(syncedSessionPrRefSchema)
    .max(MAX_SYNCED_SESSION_PR_REFS)
    .optional(),
  agents: z.array(syncedAgentSessionAgentSchema),
  events: z.array(syncedAgentSessionEventSchema),
  tokenUsageByModel: z.array(syncedAgentSessionTokenUsageSchema),
  // FEA-2730: additive optional sections. Absence means "no replacement data"
  // (the service leaves previously persisted rows untouched); an explicit empty
  // tokenEvents array is a legitimate no-op.
  tokenEvents: z.array(syncedAgentSessionTokenEventSchema).optional(),
  sessionAnalytics: syncedAgentSessionAnalyticsSchema.nullish(),
  // T-7.7 / AC-011: per-component usage metrics for this session. Optional +
  // additive — older desktop builds omit it; omission leaves previously
  // persisted `agent_component_session_usage` rows untouched.
  components: z
    .array(syncedComponentUsageSchema)
    .max(MAX_SYNCED_COMPONENT_USAGE)
    .optional(),
});

const desktopAgentSessionsPayloadSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION),
    batchId: z.string().uuid(),
    syncMode: z.enum(syncModeValues),
    sessionCount: z.number().int().nonnegative(),
    sessions: z.array(syncedAgentSessionSchema).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.sessionCount !== value.sessions.length) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionCount"],
        message: "session_count_mismatch",
      });
    }
    for (const [index, session] of value.sessions.entries()) {
      const sourcePayload = {
        tracePhaseSources: session.tracePhaseSources,
        throttleSources: session.throttleSources,
        correctionSources: session.correctionSources,
      };
      const bytes = Buffer.byteLength(JSON.stringify(sourcePayload));
      if (bytes > SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes) {
        ctx.addIssue({
          code: "custom",
          path: ["sessions", index],
          message: "session_trace_source_payload_too_large",
        });
      }
    }
  });

export type DesktopAgentSessionsParseResult =
  | {
      ok: true;
      kind: "batch";
      payload: ParsedDesktopAgentSessionsPayload;
    }
  | { ok: false; reason: string };

/**
 * The only synced fields whose object *keys* are persisted verbatim into a jsonb
 * column and can therefore lose data if two keys collapse to one after
 * sanitization: a session's `metadata` and each agent's `metadata`. (FEA-2718
 * dropped the event `data`/`summary` columns — the schema now strips event
 * `data` before any DB write, so a collision inside it can no longer lose
 * persisted data and must not reject the batch.) Every other synced field is a
 * typed scalar/array whose keys are fixed ASCII identifiers (they never contain
 * a NUL or lone surrogate, so they cannot collide), and any unknown key at those
 * structural levels is stripped by the schema before a DB write. Scoping the
 * sanitized-key-collision check to these blobs is what keeps a collision in a
 * desktop-local / forward-compat field (which the schema drops) from wrongly
 * rejecting an otherwise-valid payload.
 */
const REJECT_COLLISIONS = { rejectKeyCollisions: true } as const;

// Narrow an unknown to a plain record, or null if it isn't an object.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// A session's own `metadata` blob plus each of its agents' `metadata` blobs —
// the persisted jsonb whose keys survive verbatim on the sync batch. Non-object
// blobs are a harmless no-op.
function assertSessionMetadataBlobs(
  sessionRecord: Record<string, unknown>
): void {
  sanitizePostgresJson(sessionRecord.metadata, REJECT_COLLISIONS);
  const rawAgents = Array.isArray(sessionRecord.agents)
    ? sessionRecord.agents
    : [];
  for (const rawAgent of rawAgents) {
    const agentRecord = asRecord(rawAgent);
    if (agentRecord) {
      sanitizePostgresJson(agentRecord.metadata, REJECT_COLLISIONS);
    }
  }
}

function assertPersistedJsonBlobsHaveNoKeyCollision(rawPayload: unknown): void {
  // Re-run the sanitizer on the RAW blobs (pre-sanitization keys still intact)
  // with collision rejection ON. The main sanitize pass leaves collisions to a
  // silent last-write-wins so that stripped fields can't trigger a rejection;
  // this narrow pass is where a real, data-losing collision in a persisted blob
  // is surfaced. `sanitizePostgresJson` ignores non-object blobs, so passing an
  // absent/typed value is a harmless no-op.
  const record = asRecord(rawPayload);
  if (!record) {
    return;
  }
  // Batch payload: sessions[].metadata and sessions[].agents[].metadata. Event
  // `data` is deliberately NOT checked — FEA-2718 dropped it from the persisted
  // event shape (the schema strips it before any DB write), so a key collision
  // there loses no persisted data and must not reject an otherwise-valid batch.
  const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];
  for (const rawSession of rawSessions) {
    const sessionRecord = asRecord(rawSession);
    if (sessionRecord) {
      assertSessionMetadataBlobs(sessionRecord);
    }
  }
}

export function parseDesktopAgentSessionsPayload(
  payload: unknown
): DesktopAgentSessionsParseResult {
  // FEA-2258: strip NULs and lone surrogates BEFORE validation. Postgres
  // rejects both in text/jsonb, which would otherwise throw the whole upsert
  // transaction and surface to the desktop as an opaque `ingestion_failed`
  // (then dead-letter after retries). Sanitizing must happen before the schema
  // runs, not after: stripping a NUL can shorten or empty a string, so a
  // sanitize-after-validate would let a required `min(1)` field (e.g. an
  // identity/persistence key like externalSessionId) pass as "\0" and then
  // collapse to "" — a shape the schema would have rejected. Validating the
  // sanitized payload guarantees the persisted values still satisfy the schema.
  // The sanitizer is depth-bounded, and the handler rate-limits before calling
  // this, so an abusive target is throttled before paying the traversal cost.
  //
  // FEA-2691: the main pass does NOT reject sanitized-key collisions — doing so
  // on the whole raw payload would reject collisions in desktop-local /
  // forward-compat fields the schema strips before any DB write. A real,
  // data-losing collision is caught by the scoped pass below, which only
  // inspects the fields whose keys are persisted verbatim.
  let sanitizedPayload: unknown;
  try {
    sanitizedPayload = sanitizePostgresJson(payload);
    assertPersistedJsonBlobsHaveNoKeyCollision(payload);
  } catch (error) {
    if (error instanceof PostgresJsonDepthExceededError) {
      return { ok: false, reason: "payload_nested_too_deeply" };
    }
    if (error instanceof PostgresJsonKeyCollisionError) {
      return { ok: false, reason: "payload_sanitized_key_collision" };
    }
    throw error;
  }

  const parsed = desktopAgentSessionsPayloadSchema.safeParse(sanitizedPayload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: summarizeParseIssues(parsed.error.issues),
    };
  }

  return {
    ok: true,
    kind: "batch",
    payload: {
      schemaVersion: parsed.data.schemaVersion,
      batchId: parsed.data.batchId,
      syncMode: parsed.data.syncMode,
      sessionCount: parsed.data.sessionCount,
      sessions: parsed.data.sessions as ParsedSyncedAgentSession[],
    },
  };
}

function summarizeParseIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>
): string {
  const issue = issues[0];
  if (!issue) {
    return "payload_invalid";
  }
  const [root, ...rest] = issue.path;
  if (root === "schemaVersion") {
    return "schema_version_invalid";
  }
  if (root === "batchId") {
    return "batch_id_invalid";
  }
  if (root === "syncMode") {
    return "sync_mode_invalid";
  }
  if (root === "sessionCount") {
    return issue.message === "session_count_mismatch"
      ? "session_count_mismatch"
      : "session_count_invalid";
  }
  if (root === "sessions") {
    if (issue.message === "session_trace_source_payload_too_large") {
      return issue.message;
    }
    return rest.length > 0 ? "session_invalid" : "sessions_invalid";
  }
  return "payload_invalid";
}
