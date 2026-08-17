import { FRUSTRATION_RAW_MAX } from "@repo/api/src/frustration-score-contract";
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION as API_AGENT_SESSION_SYNC_SCHEMA_VERSION,
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT as API_DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  AgentSessionSyncMode as ApiAgentSessionSyncMode,
  DesktopAgentSessionsAckReason as ApiDesktopAgentSessionsAckReason,
  MAX_SUPPORTED_DATA_REVISION,
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  MAX_SYNCED_COMPONENT_USAGE,
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
  SYNCED_COMPONENT_IDENTITY_MAX_CHARS,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import {
  isKnownArtifactRefKind,
  MAX_SYNCED_ARTIFACT_REFS,
  MAX_SYNCED_SESSION_PR_REFS,
  PR_INT_MAX,
  syncedArtifactRefSchema,
  syncedSessionPrRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import {
  SYNCED_COMPONENT_CONTENT_MAX_CHARS,
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import {
  tokenCostSummarySchema,
  tokenEventTransportIdSchema,
  tokenSourceIdentitySchema,
} from "@repo/api/src/types/token-cost-provenance";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/lib/session-trace/derivation";
import { normalizeRepositoryIdentity } from "@repo/lib/sessions/repository-identity";
import { z } from "zod";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
} from "./agent-sessions-text-sanitizer";
import {
  assertPersistedJsonBlobsHaveNoKeyCollision,
  summarizeParseIssues,
} from "./desktop-agent-sessions-parse-guards";
import {
  boundedDurationStringSchema,
  boundedNullableTrimmedStringSchema,
  isoDateSchema,
  nullableTrimmedStringSchema,
  optionalJsonObjectSchema,
  optionalPreservedTrimmedStringSchema,
} from "./desktop-agent-sessions-schema-primitives";
import {
  projectKnownTokenCostSummary,
  projectKnownTokenSourceIdentity,
} from "./desktop-agent-sessions-token-provenance-projection";

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

// ---------------------------------------------------------------------------
// T-7.7: Zod schemas for component inventory sync (SyncedComponent) and
// per-session component usage (SyncedComponentUsage).
// ---------------------------------------------------------------------------

/**
 * ISS-4662: one RETAINED lower-precedence content variant of a synced component.
 * Mirrors `SyncedComponentVariant` from
 * `packages/api/src/types/synced-component-content.ts`.
 *
 * Deliberately NOT `.strict()`, matching every sibling schema on this route: a
 * NEWER desktop that adds another variant field must have its unknown key
 * STRIPPED, never reject the whole batch — a strict boundary here would drop the
 * entire 200-component payload (and re-drop it on every retry) over one field the
 * cloud had not learned yet.
 *
 * `contentHash` and `content` are required because a variant with neither is not
 * a revision; everything else is optional so an older/leaner producer degrades.
 */
export const syncedComponentVariantSchema = z.object({
  contentHash: z
    .string()
    .trim()
    .min(1)
    .max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS),
  content: z.string().max(SYNCED_COMPONENT_CONTENT_MAX_CHARS),
  format: nullableTrimmedStringSchema,
  firstSeenAt: isoDateSchema.nullable().optional(),
  lastSeenAt: isoDateSchema.nullable().optional(),
});

/**
 * The per-component FIELD shape, before the ISS-5029 object-level variants cap
 * wraps it. Kept separate only so `capSyncedComponentVariants` can be typed
 * against `z.infer` of this schema without referring to its own output type.
 * Consumers use {@link syncedComponentSchema}.
 */
export const syncedComponentFieldsSchema = z.object({
  // Identity fields feed the org-identity slug + `search_document` route
  // metadata, so they carry a length cap (FEA-4011) unlike the other free-form
  // strings — an unbounded key/name could inflate one query's route metadata.
  externalId: z.string().trim().min(1).max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS),
  componentKind: z
    .string()
    .trim()
    .min(1)
    .max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS),
  harness: nullableTrimmedStringSchema,
  name: boundedNullableTrimmedStringSchema,
  componentKey: boundedNullableTrimmedStringSchema,
  version: nullableTrimmedStringSchema,
  description: nullableTrimmedStringSchema,
  sourceUrl: nullableTrimmedStringSchema,
  installPath: nullableTrimmedStringSchema,
  packId: nullableTrimmedStringSchema,
  scope: nullableTrimmedStringSchema,
  projectPath: nullableTrimmedStringSchema,
  metadata: optionalJsonObjectSchema,
  // FEA-2923 content pipeline: bounded definition text + its sha256. Additive +
  // optional, so a stale desktop that omits them is still accepted (fields fold
  // to null). `content` is length-capped to reject pathological bodies.
  content: z
    .string()
    .max(SYNCED_COMPONENT_CONTENT_MAX_CHARS)
    .nullable()
    .optional(),
  contentHash: nullableTrimmedStringSchema,
  // ISS-4662: when the PRIMARY revision's hash was first observed locally, so
  // the primary and the variants below share one `firstSeenAt` meaning.
  // Additive + optional; an older desktop omits it and the cloud falls back to
  // the previous `lastSeenAt` seeding rule.
  contentFirstSeenAt: isoDateSchema.nullable().optional(),
  // ISS-4662: retained per-content-hash variants (ISS-4564) of this identity.
  // Additive + optional: an older desktop omits the key entirely and the cloud
  // writes exactly the one primary version row it always did.
  //
  // TRUNCATES rather than rejects. `SYNCED_COMPONENT_VARIANTS_MAX` still bounds
  // what the cloud will store — a pathological identity must not inflate a
  // 200-component batch — but enforcing it with `.max()` had the exact blast
  // radius the `.strict()` note above argues against: `route.ts` safeParses the
  // WHOLE payload and returns 400 with no per-component salvage, so a single
  // component carrying one variant too many would reject the entire batch of up
  // to 200 components and keep rejecting it on every retry, stalling the
  // existence rows with no signal that anything was dropped. Producer and
  // consumer share the constant today, but this field crosses a repo boundary
  // and root AGENTS.md requires a newer peer to degrade rather than block core
  // flows. Slicing keeps the newest-first prefix the desktop packer sends
  // (closedloop-ai-stage, #4295).
  //
  // ISS-5029 (wongk, #4391): that slice now lives in
  // `capSyncedComponentVariants`, the OBJECT-level transform, because a
  // field-level transform cannot reach the sibling `variantsTruncated` — so the
  // cap dropped revisions and the writer then stored the result as a complete
  // history, reproducing this ticket's own bug one layer down.
  variants: z.array(syncedComponentVariantSchema).optional(),
  // ISS-5029: the desktop packer's honest "this identity has MORE retained
  // revisions than `variants` carries" marker, set where a per-family cap or the
  // per-component variant byte budget actually BOUND.
  //
  // Additive + optional, and all THREE states are distinct (wongk, #4391): a
  // marker-aware desktop sends `true` or `false` on every component, while a
  // desktop that predates the marker omits the key and thereby expresses no
  // opinion — the writer leaves the stored value untouched rather than clearing
  // a `true` an upgraded peer device recorded.
  variantsTruncated: z.boolean().optional(),
  // ISS-5029 (wongk, #4391): WHICH cap bound, ridden only with `true`. Kept as
  // an unconstrained string rather than a `z.enum` on purpose — this crosses a
  // repo boundary, `route.ts` safeParses the WHOLE batch, and an enum would let
  // one component carrying a future reason from a newer desktop reject up to 200
  // components on every retry. The reader maps an unrecognized value to "no
  // proof", which is the same safe default as absent. Length-bounded like the
  // other identity-adjacent strings so an abusive value cannot bloat the column,
  // and `.nullish()` rather than a trimming helper so OMISSION survives parsing
  // distinctly from an explicit null — the value is a machine-generated
  // identifier, so there is no whitespace to normalize.
  variantsTruncatedReason: z
    .string()
    .max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS)
    .nullish(),
  // F1 (FEA-3290 / PRD-527 Slice 4) — honest resolution state (AC-007). Additive
  // + optional so a stale desktop that omits it is still accepted: an omitted
  // value folds to `undefined` and the cloud writer leaves the existing state
  // untouched (never demotes a resolved row). Constrained to the
  // `ComponentResolvedState` enum values so an out-of-range string is rejected.
  resolvedState: z
    .enum(["resolved", "unresolved", "inaccessible", "missing"])
    .optional(),
  firstSeenAt: isoDateSchema.nullable().optional(),
  lastSeenAt: isoDateSchema.nullable().optional(),
  uninstalledAt: isoDateSchema.nullable().optional(),
  // FEA-3290 (F1, Slice 3): additive, optional source-evidence + scan metadata.
  // A stale desktop that omits these is still accepted (fields fold to null/
  // undefined). The cloud registry writer derives the fingerprint itself from
  // `content`; a client-supplied `definitionHash` is carried for forward-compat
  // but is never trusted as identity without re-derivation.
  definitionHash: nullableTrimmedStringSchema,
  normalizerContractVersion: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional(),
  accessState: z.enum(["accessible", "inaccessible"]).nullable().optional(),
  scannedAt: isoDateSchema.nullable().optional(),
});

/**
 * Mirrors `SyncedComponent` from `packages/api/src/types/agent-session.ts`.
 * Used by `desktopAgentComponentsPayloadSchema` for `POST /desktop/components/sync`.
 *
 * ISS-5029 (wongk, #4391): the object-level transform is where the variants cap
 * is enforced, because enforcing it on the `variants` field alone could not
 * reach `variantsTruncated` — the API sliced revisions off and then stored the
 * result as a complete history.
 */
export const syncedComponentSchema = syncedComponentFieldsSchema.transform(
  capSyncedComponentVariants
);

// The ISS-5164 whole-shape keys-covered guard over `SyncedComponent` lives in
// `desktop-agent-sessions-schema-guards.ts` with the other compile-time guards.

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
  // FEA-2923: the component's content hash at invocation. Additive/optional.
  componentVersionHash: nullableTrimmedStringSchema,
});

// Token counts cross the wire as JSON numbers, deliberately kept within the
// 2^53 safe-integer envelope rather than stringified: the desktop preserves the
// same ceiling and the cloud stores them in BigInt (int8) columns, so a session
// that exceeds the old int4 limit (2,147,483,647) carries through without
// truncation or precision loss. See the BigInt-carry regression in
// app/desktop/agent-sessions/sync/route.integration.test.ts (FEA-2728).
const syncedAgentSessionTokenUsageSchema = z
  .object({
    model: z.string().trim().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    cacheWrite5mTokens: z.number().int().nonnegative().nullish(),
    cacheWrite1hTokens: z.number().int().nonnegative().nullish(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
  })
  .superRefine((usage, context) => {
    const fiveMinuteTokens = usage.cacheWrite5mTokens;
    const oneHourTokens = usage.cacheWrite1hTokens;
    const hasFiveMinuteTokens = fiveMinuteTokens != null;
    const hasOneHourTokens = oneHourTokens != null;
    if (hasFiveMinuteTokens !== hasOneHourTokens) {
      context.addIssue({
        code: "custom",
        message: "cache-write TTL fields must be supplied together",
        path: ["cacheWrite5mTokens"],
      });
      return;
    }
    if (
      fiveMinuteTokens != null &&
      oneHourTokens != null &&
      fiveMinuteTokens + oneHourTokens > usage.cacheWriteTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "cache-write TTL subdivision exceeds cacheWriteTokens",
        path: ["cacheWrite5mTokens"],
      });
    }
  });

// FEA-2730 (G1): raw per-event token rows. Same 2^53 numeric envelope as
// tokenUsageByModel above (land in BigInt columns). `externalEventId` is the
// provider-neutral transport identity and the sole idempotency key for re-sync.
// ISS-4882 consumes the additive ISS-4881 provenance/cost contract here; both
// fields stay optional so older producers and servers preserve omission.
// Cloud token-event costs land in DECIMAL(14,6). Keep the shared producer
// contract provider-neutral, but reject values here that would round beyond the
// owning cloud column instead of dead-lettering the persistence transaction.
const TOKEN_EVENT_COST_STORAGE_MAX_USD = 99_999_999.999_999;
/** Maximum token-event rows accepted in one already-byte-bounded sync chunk. */
export const MAX_SYNCED_TOKEN_EVENTS_PER_SESSION = 10_000;
const persistedTokenCostSummarySchema = tokenCostSummarySchema.superRefine(
  (summary, context) => {
    if (
      "subtotalUsd" in summary &&
      !isPersistableTokenCost(summary.subtotalUsd)
    ) {
      context.addIssue({
        code: "custom",
        message: "token-event subtotal exceeds cloud storage precision",
        path: ["subtotalUsd"],
      });
    }
    if (!("lanes" in summary) || summary.lanes === undefined) {
      return;
    }
    for (const [index, lane] of summary.lanes.entries()) {
      if (!isPersistableTokenCost(lane.subtotalUsd)) {
        context.addIssue({
          code: "custom",
          message: "token-event lane exceeds cloud storage precision",
          path: ["lanes", index, "subtotalUsd"],
        });
      }
    }
  }
);
export const syncedAgentSessionTokenEventObjectSchema = z.object({
  externalEventId: tokenEventTransportIdSchema,
  agentExternalId: nullableTrimmedStringSchema,
  model: z.string().trim().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z
    .number()
    .finite()
    .nonnegative()
    .refine(isPersistableTokenCost, {
      message: "token-event cost exceeds cloud storage precision",
    })
    .optional(),
  createdAt: isoDateSchema,
  sourceIdentity: z.preprocess(
    projectKnownTokenSourceIdentity,
    tokenSourceIdentitySchema.optional()
  ),
  costSummary: z.preprocess(
    projectKnownTokenCostSummary,
    persistedTokenCostSummarySchema.optional()
  ),
});
const syncedAgentSessionTokenEventSchema =
  syncedAgentSessionTokenEventObjectSchema.transform(
    ({ sourceIdentity, costSummary, ...event }) => ({
      ...event,
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      ...(costSummary === undefined ? {} : { costSummary }),
    })
  );

// The ISS-4882 token-provenance keys-covered guard lives in
// `desktop-agent-sessions-schema-guards.ts` with the other compile-time guards.

function isPersistableTokenCost(value: number): boolean {
  return Number(value.toFixed(6)) <= TOKEN_EVENT_COST_STORAGE_MAX_USD;
}

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
  /*
   * ISS-5819 review (wongk): the producer's own bin bounds. `.optional()`, so a
   * version-skewed desktop that does not send them still validates and the key
   * stays ABSENT on the way back out rather than becoming a `null` the renderer
   * would have to re-interpret. Renderers must treat absence as "no usable
   * clock" and stay on the ordinal strip.
   */
  binStartMs: z.number().finite().optional(),
  binEndMs: z.number().finite().optional(),
});

/**
 * FEA-3568: one raw activity-segment tiling row on the sync wire. Mirrors the
 * desktop `session_lis` shape verbatim; the cloud never re-classifies. `phase`
 * is a bounded free string (taxonomy is desktop-owned; a label-set change is a
 * classifier-version bump, not a contract change). `evidenceLayers` are layer
 * NAMES only — no prose rides this lane. Unknown keys are stripped (forward
 * compat). The half-open span invariant `startMs < endMs` is enforced per row.
 */
export const syncedActivitySegmentRowSchema = z
  .object({
    phase: z.string().trim().min(1).max(64),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().finite().min(0).max(1),
    evidenceLayers: z.array(z.string().trim().min(1).max(64)).max(16),
    version: z.number().int().nonnegative(),
    workItemRef: nullableTrimmedStringSchema,
    subagentId: nullableTrimmedStringSchema,
  })
  .refine((segment) => segment.startMs < segment.endMs, {
    // Half-open [startMs, endMs): a zero-width or inverted span is a producer bug;
    // reject the row rather than persist a degenerate tiling cloud-side.
    message: "activity_segment_bounds_invalid",
    path: ["endMs"],
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
    // ISS-4996: close the MALFORMED repository class at the writer boundary for
    // every producer. `nullableTrimmedStringSchema` alone nulls empty and
    // whitespace-only values but PRESERVES slash-only ones ("/", "//"), which
    // then persist as a stored value carrying no identity — the one case the
    // Sessions cell still has to label "Unknown" rather than treat as absent.
    // Normalizing on ingest turns "malformed is measured-zero" into "malformed
    // is impossible", instead of leaving a latent unfilterable label that
    // reappears the first time a degenerate value lands. Shared with the render
    // boundary via `@repo/lib` so the writer and the reader cannot drift on
    // what counts as identity.
    repositoryFullName: nullableTrimmedStringSchema.transform(
      normalizeRepositoryIdentity
    ),
    worktreePath: nullableTrimmedStringSchema,
    sourceArtifactId: nullableTrimmedStringSchema,
    sourceLoopId: nullableTrimmedStringSchema,
    baseBranch: nullableTrimmedStringSchema,
  })
  .nullable()
  .optional()
  .transform((value) => value ?? null);

// FEA-3267: session-level diff-stat LOC lands in the Postgres int4 columns
// SessionDetail.lines_added/branch_lines_added, so cap every wire LOC field at
// PR_INT_MAX (the int4 ceiling). Without it a session whose summed LOC overflows
// int4 makes the sink throw "integer out of range", failing the whole-session
// (and batch) upsert. Mirrors the already-bounded PR/commit-ref LOC path.
const boundedLocFieldSchema = z.number().int().nonnegative().max(PR_INT_MAX);

export const syncedAgentSessionSchema = z.object({
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
  // ISS-4586: whether the run ended on an unrecovered error (the desktop's
  // `ends_with_error` flag). Accepted additively — older desktop builds omit it
  // (absent → the reaper treats it as not-error → INACTIVE). This boundary must
  // accept the field BEFORE the desktop producer ships it (deploy cloud first).
  endsWithError: z.boolean().nullish(),
  metadata: optionalJsonObjectSchema,
  attribution: syncedAgentSessionAttributionSchema,
  /** FEA-1459: device IANA timezone for timezone-aware day attribution. */
  deviceTimeZone: z.string().min(1).max(64).nullish(),
  branch: optionalPreservedTrimmedStringSchema,
  prs: z.array(sessionPrSchema).max(MAX_SYNCED_SESSION_PR_REFS).nullish(),
  // ISS-4675: the three pre-formatted duration strings carry a LENGTH BOUND the
  // other free-form fields do not. They are bulk-read into the 10,000-row
  // `?sortBy=duration` candidate scan (`session-display-sort.ts`), so an
  // unbounded value is a read-path memory amplifier, not merely an unreadable
  // one — ten thousand near-request-limit strings would land in a single sort
  // read. The cap is checked BEFORE the trim transform so an over-long payload
  // is 400'd rather than stored, matching `boundedNullableTrimmedStringSchema`.
  wallClock: boundedDurationStringSchema,
  activeAgent: boundedDurationStringSchema,
  waitingUser: boundedDurationStringSchema,
  linesAdded: boundedLocFieldSchema.nullable().optional(),
  linesRemoved: boundedLocFieldSchema.nullable().optional(),
  filesChanged: boundedLocFieldSchema.nullable().optional(),
  gitDiffStats: z
    .object({
      linesAdded: boundedLocFieldSchema,
      linesRemoved: boundedLocFieldSchema,
      filesChanged: boundedLocFieldSchema,
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  branchDiffStats: z
    .object({
      linesAdded: boundedLocFieldSchema,
      linesRemoved: boundedLocFieldSchema,
      filesChanged: boundedLocFieldSchema,
      source: z.string().trim().min(1).max(64),
    })
    .nullable()
    .optional(),
  turns: z.number().int().nonnegative().nullable().optional(),
  steeringEpisodes: z.number().int().nonnegative().nullable().optional(),
  autonomy: z.number().int().min(0).max(100).nullable().optional(),
  activityBuckets: z.array(activityBucketSchema).max(500).nullish(),
  // FEA-3568: raw activity-segment tiling (session_lis) replicated to the cloud.
  // Optional + additive — omission leaves previously persisted segments untouched
  // (mirrors tokenEvents/activityBuckets); capped at MAX_SYNCED_ACTIVITY_SEGMENTS
  // (the desktop assembly caps at the same value so it never oversends).
  activitySegmentRows: z
    .array(syncedActivitySegmentRowSchema)
    .max(MAX_SYNCED_ACTIVITY_SEGMENTS)
    .nullish(),
  // FEA-3779: true when the raw tiling exceeded MAX_SYNCED_ACTIVITY_SEGMENTS and
  // activitySegmentRows was truncated by start order, so the cloud knows it holds
  // a partial tiling. Optional + additive (older desktop builds omit it → complete).
  activitySegmentRowsTruncated: z.boolean().nullish(),
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
  // FEA-4022 (PLN-1481): the raw, UNBOUNDED-at-100 additive frustration signal
  // and the scorer version stamp, computed locally by the desktop. Optional +
  // additive (older builds omit both). Bounded [0, FRUSTRATION_RAW_MAX] to match
  // the int4-safe cloud column; the scorer already saturates at that ceiling so
  // a pathological transcript can never overflow and reject the whole batch.
  // Persisted cloud-side ONLY when the org opted into `calculateSessionFrustration`.
  frustrationRaw: z.number().int().min(0).max(FRUSTRATION_RAW_MAX).nullish(),
  // Bounded to the same int4 ceiling as the raw signal: the scorer version
  // persists to a Prisma `Int` (Postgres int4) column, so a malformed or
  // newer-than-int4 desktop payload must be rejected at the boundary rather than
  // overflow the column and abort the whole batch in Postgres.
  frustrationScoreVersion: z
    .number()
    .int()
    .min(1)
    .max(FRUSTRATION_RAW_MAX)
    .nullish(),
  // FEA-3595: bounded because forward-only revision gating makes the accepted
  // value an irreversible high-water mark — see MAX_SUPPORTED_DATA_REVISION.
  dataRevision: z
    .number()
    .int()
    .min(1)
    .max(MAX_SUPPORTED_DATA_REVISION)
    .nullish(),
  // FEA-3788 (PRD-536 D3): per-chunk metadata for an oversized session split into
  // parts. Optional + additive — older desktop builds omit it and the cloud treats
  // the payload as an unchunked whole session (chunk 0 of 1). `index` is 0-based
  // and strictly less than `total`; a payload violating that is rejected so a
  // malformed chunk marker can never mis-gate the revision-commit/delete logic.
  chunk: z
    .object({
      index: z.number().int().min(0),
      total: z.number().int().min(1),
    })
    .refine((value) => value.index < value.total, {
      message: "chunk.index must be < chunk.total",
    })
    .nullish(),
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
  tokenEvents: z
    .array(syncedAgentSessionTokenEventSchema)
    .max(MAX_SYNCED_TOKEN_EVENTS_PER_SESSION)
    .optional(),
  sessionAnalytics: syncedAgentSessionAnalyticsSchema.nullish(),
  // T-7.7 / AC-011: per-component usage metrics for this session. Optional +
  // additive — older desktop builds omit it; omission leaves previously
  // persisted `agent_component_session_usage` rows untouched.
  components: z
    .array(syncedComponentUsageSchema)
    .max(MAX_SYNCED_COMPONENT_USAGE)
    .optional(),
});

// The FEA-4022 frustration and ISS-4586 ends_with_error keys-covered guards
// live in `desktop-agent-sessions-schema-guards.ts` with the other
// compile-time guards.

export const desktopAgentSessionsPayloadObjectSchema = z.object({
  schemaVersion: z.literal(AGENT_SESSION_SYNC_SCHEMA_VERSION),
  batchId: z.string().uuid(),
  syncMode: z.enum(syncModeValues),
  sessionCount: z.number().int().nonnegative(),
  sessions: z.array(syncedAgentSessionSchema).max(200),
  // FEA-4138: optional, additive self-describing wire encoding. The body was
  // already decompressed at the route boundary (dispatched on the HTTP
  // `Content-Encoding` header), so this is informational — an older desktop
  // omits it (legacy uncompressed), and a newer one stamps `gzip`. Accepted
  // but not required; the schema is not `.strict()`, so it degrades either way.
  encoding: z.nativeEnum(SyncPayloadEncoding).optional(),
  // Goal stage 2: the client's opt-in to `acceptedSessionIds` on the success
  // response. Optional + additive — an older desktop omits it and gets the
  // legacy `{ synced: true }` response; a server that predates this field
  // strips it (non-strict schema) and the new desktop degrades to whole-batch
  // ack semantics. MUST be declared here (not left to be stripped): the
  // handler reads it off the parsed payload to decide the response shape, and
  // a stripped flag would silently downgrade every new client (the ISS-4586
  // stripped-field class of bug — see `wantsAcceptedSessionIdsKeyCovered`).
  wantsAcceptedSessionIds: z.boolean().optional(),
});

const desktopAgentSessionsPayloadSchema =
  desktopAgentSessionsPayloadObjectSchema.superRefine((value, ctx) => {
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
      // FEA-4138: preserve the optional wire-encoding declaration when present
      // so the parsed batch stays self-describing (omit the key entirely when
      // absent — additive, no `null` for a missing optional cross-repo field).
      ...(parsed.data.encoding ? { encoding: parsed.data.encoding } : {}),
      // Goal stage 2: preserve the response-shape opt-in when present (omit
      // when absent — additive, no `null` for a missing optional field).
      ...(parsed.data.wantsAcceptedSessionIds === true
        ? { wantsAcceptedSessionIds: true }
        : {}),
    },
  };
}

// The goal-stage-2 `wantsAcceptedSessionIds` keys-covered guard lives in
// `desktop-agent-sessions-schema-guards.ts` with the other compile-time guards.

/**
 * ISS-5029 (wongk, #4391): enforce {@link SYNCED_COMPONENT_VARIANTS_MAX} on an
 * incoming component AND say so on the same object.
 *
 * The cap TRUNCATES rather than rejects, for the reason spelled out on the
 * `variants` field: `route.ts` safeParses the whole batch with no per-component
 * salvage, so a `.max()` here would let one pathological component reject up to
 * 200 others on every retry. But truncating on the field alone left the write
 * path claiming a complete history for a set the API had itself just shortened —
 * the same misleading-completeness bug this ticket exists to remove, reproduced
 * one layer below the desktop packer. Setting the marker in the same pass is
 * what makes the drop honest.
 *
 * It overrides an incoming `variantsTruncated: false`, and overrides the
 * incoming reason with `family_cap`, deliberately: whatever the sender believed
 * about ITS packing, THIS cap just dropped revisions the sender shipped, and an
 * entry cap that bound is exactly what `family_cap` denotes. Untouched when the
 * array fits, so the far more common path returns the same object identity and
 * the sender's own marker survives verbatim.
 */
function capSyncedComponentVariants(
  component: z.infer<typeof syncedComponentFieldsSchema>
): z.infer<typeof syncedComponentFieldsSchema> {
  const { variants } = component;
  if (!variants || variants.length <= SYNCED_COMPONENT_VARIANTS_MAX) {
    return component;
  }
  return {
    ...component,
    variants: variants.slice(0, SYNCED_COMPONENT_VARIANTS_MAX),
    variantsTruncated: true,
    variantsTruncatedReason: SyncedComponentVariantsTruncatedReason.FamilyCap,
  };
}
