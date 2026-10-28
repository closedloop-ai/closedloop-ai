import { canStoreAuthoritativeCostUsd } from "@repo/api/src/constants";
import { FRUSTRATION_RAW_MAX } from "@repo/api/src/frustration-score-contract";
import {
  ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS,
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION as API_AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
} from "@repo/api/src/types/agent-component-sync-schema-version";
import type {
  DesktopAgentSessionsPayload as ParsedDesktopAgentSessionsPayload,
  SyncedAgentSession as ParsedSyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION as API_AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode as ApiAgentSessionSyncMode,
  DesktopAgentSessionsAckReason as ApiDesktopAgentSessionsAckReason,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { AGENT_SESSION_NAME_MAX_CHARS } from "@repo/api/src/types/agent-session-rename";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  COVERAGE_RATIO_RANGE,
  MAX_ROLLUP_COUNT,
  MAX_TIER_SPEND_USD,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import {
  PR_INT_MAX,
  syncedArtifactRefSchema,
  syncedPrioritySchema,
  syncedSessionPrRefSchema,
} from "@repo/api/src/types/session-artifact-link";
import {
  SYNCED_COMPONENT_VARIANTS_MAX,
  SyncedComponentVariantsTruncatedReason,
} from "@repo/api/src/types/synced-component-content";
import { MAX_METADATA_KEYS } from "@repo/lib/agent-sessions/metadata-preview";
import { protoSafeRecord } from "@repo/lib/security/proto-safe-record";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/lib/session-trace/derivation";
import { normalizeRepositoryIdentity } from "@repo/lib/sessions/repository-identity";
import { z } from "zod";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
} from "./agent-sessions-text-sanitizer";
import { syncedOperationEvidenceSchema } from "./desktop-agent-sessions-operation-evidence-schema";
import {
  assertPersistedJsonBlobsHaveNoKeyCollision,
  summarizeParseIssues,
} from "./desktop-agent-sessions-parse-guards";
import {
  collectOversizedPullRequestRefDrops,
  type DesktopAgentSessionsPayloadDiagnostic,
  dropOversizedSessionPrRefs,
  filterForwardCompatibleArtifactRefs,
} from "./desktop-agent-sessions-pr-number-preprocess";
import {
  boundedDurationStringSchema,
  ianaTimeZoneSchema,
  isoDateSchema,
  nullableTrimmedStringSchema,
  optionalJsonObjectSchema,
  optionalPreservedTrimmedStringSchema,
  syncedSessionCreatedAtSchema,
  truncatedBillingModeSchema,
} from "./desktop-agent-sessions-schema-primitives";
import { acceptedBatchSchemaVersionSchema } from "./desktop-agent-sessions-schema-version";
import {
  syncedAgentSessionTokenEventSchema,
  syncedAgentSessionTokenUsageSchema,
} from "./desktop-agent-sessions-token-schema";
import {
  phaseLoopbackSchema,
  sessionMarkerSchema,
  sessionPhaseSchema,
  sessionSpanSchema,
  sessionThrottleSchema,
  sessionTraceCorrectionSourceSchema,
  sessionTracePhaseSourceSchema,
  sessionTraceThrottleSourceSchema,
} from "./desktop-agent-sessions-trace-schema";

export type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";

/*
 * ISS-8051: a free-form string here must not carry a REJECTING length cap.
 * `route.ts` safeParses the WHOLE batch, so `.max()` on a string is not a
 * truncation — one over-long value 400s up to 200 sessions with no per-item
 * salvage, and keeps 400ing them on every retry. The payload is bounded by the
 * REQUEST instead: `readBoundedMaybeGzipJsonBody` refuses a body expanding past
 * `SYNC_DECOMPRESSED_BYTE_CEILING` (16 MiB), behind a per-target rate limit.
 *
 * "No rejecting cap" is NOT "unbounded". Where a downstream reader holds a
 * premise about the value, bound it WITHOUT rejecting — see the three survivors
 * in `./desktop-agent-sessions-schema-primitives`, each documented there:
 * the numeric `.max()`es (int4 column ceilings), the value domains
 * `boundedDurationStringSchema` and `ianaTimeZoneSchema`, and the truncations
 * `truncatedBillingModeSchema` and `truncatedMarkerLabelSchema`.
 *
 * The btree index-key bound used to be a fourth survivor here. It is now
 * applied at the WRITE instead (ISS-8736, ISS-8201) — see
 * `toComponentIndexKeys` — which is the only place a BYTE budget can be
 * enforced; a `.max()` counts CHARACTERS and so could never bound the tuple it
 * claimed to protect.
 *
 * So the test is not "is it a string?" but "does anything downstream hold a
 * premise this bound guarantees?" Check the column type, its indexes, and its
 * readers before removing one, and prefer truncating to rejecting.
 */

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

/**
 * Re-exported so this module stays the one place `apps/api` reaches for the
 * component-sync wire shapes. Both the stamped version and the ACCEPTED set are
 * declared in `@repo/api/src/types/agent-component-sync-schema-version` — the
 * accepted set is built from named historical literals rather than from the
 * stamped alias, and that file says why (ISS-8609, following ISS-6886).
 */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION =
  API_AGENT_COMPONENT_SYNC_SCHEMA_VERSION;

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
  // INDEX KEY, not payload — rides the `AgentComponentVersion`
  // `(organizationId, componentKind, componentKey, source, contentHash)` unique
  // btree, which `toComponentIndexKeys` now projects at the WRITE (ISS-8736).
  // Unbounded here for the reason stated on `syncedComponentFieldsSchema`
  // below (ISS-8201).
  contentHash: z.string().trim().min(1),
  content: z.string(),
  format: nullableTrimmedStringSchema,
  firstSeenAt: isoDateSchema.nullable().optional(),
  lastSeenAt: isoDateSchema.nullable().optional(),
  // ISS-4965: see `SyncedComponent.usageScopeHash`. Additive + optional.
  usageScopeHash: z.string().trim().min(1).optional(),
});

/**
 * The per-component FIELD shape, before the ISS-5029 object-level variants cap
 * wraps it. Kept separate only so `capSyncedComponentVariants` can be typed
 * against `z.infer` of this schema without referring to its own output type.
 * Consumers use {@link syncedComponentSchema}.
 */
export const syncedComponentFieldsSchema = z.object({
  // `externalId`, `componentKind` and `componentKey` are INDEX KEYS, not
  // payload: they are the columns of the `AgentComponent`
  // `(computeTargetId, componentKind, externalComponentId)` unique btree and
  // the `AgentComponentVersion`
  // `(organizationId, componentKind, componentKey, source, contentHash)` unique
  // btree, and `componentKey` DEFAULTS to `externalId` when the desktop omits
  // it.
  //
  // ISS-8051 kept a 512-CHARACTER cap on them so an over-long value could not
  // throw a Postgres index-size error mid-batch. ISS-8736 then made
  // `toComponentIndexKeys` project every one of these four keys down to
  // `INDEX_KEY_MAX_BYTES` at the write, so the tuple is bounded whatever
  // arrives — and ISS-8201 removed the caps, because a CHARACTER cap and a BYTE
  // budget do not describe the same set. 512 ASCII characters 400'd at this
  // parser and never reached the projection; 512 multibyte characters (up to
  // 2048 bytes) passed and were projected. Two values a producer would call
  // equivalent got two outcomes, and the ASCII one got the worse of them — a
  // rejected batch with no telemetry. One outcome now: accepted, projected at
  // the write, counted under `desktop.sync.index_key_projected`.
  //
  // The aggregate request and cardinality bounds are untouched; they are what
  // actually bounds this payload. `name` below is NOT indexed, so it is
  // unbounded like every other free-form string.
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
  // FEA-2923 content pipeline: definition text + its sha256. Additive +
  // optional, so a stale desktop that omits them is still accepted (fields fold
  // to null).
  content: z.string().nullable().optional(),
  contentHash: nullableTrimmedStringSchema,
  // ISS-4662: when the PRIMARY revision's hash was first observed locally, so
  // the primary and the variants below share one `firstSeenAt` meaning.
  // Additive + optional; an older desktop omits it and the cloud falls back to
  // the previous `lastSeenAt` seeding rule.
  contentFirstSeenAt: isoDateSchema.nullable().optional(),
  // ISS-4965: the raw-content usage digest of a secret-redacted `content`.
  // Additive + optional; an older desktop omits it and the parser derives it.
  usageScopeHash: z.string().trim().min(1).optional(),
  // ISS-4662: retained per-content-hash variants (ISS-4564) of this identity.
  // Additive + optional: an older desktop omits the key entirely and the cloud
  // writes exactly the one primary version row it always did.
  //
  // TRUNCATES rather than rejects. `SYNCED_COMPONENT_VARIANTS_MAX` still bounds
  // what the cloud will store — a pathological identity must not inflate the
  // batch — but enforcing it with `.max()` had the exact blast
  // radius the `.strict()` note above argues against: `route.ts` safeParses the
  // WHOLE payload and returns 400 with no per-component salvage, so a single
  // component carrying one variant too many would reject every other component
  // in the batch and keep rejecting them on every retry, stalling the
  // existence rows with no signal that anything was dropped. Producer and
  // consumer share the constant today, but this field crosses a repo boundary
  // and root AGENTS.md requires a newer peer to degrade rather than block core
  // flows. Slicing keeps the newest-first prefix the desktop packer sends
  // (closedloop-ai-stage, #4295).
  //
  // ISS-5029 (whitlockk, #4391): that slice now lives in
  // `capSyncedComponentVariants`, the OBJECT-level transform, because a
  // field-level transform cannot reach the sibling `variantsTruncated` — so the
  // cap dropped revisions and the writer then stored the result as a complete
  // history, reproducing this ticket's own bug one layer down.
  variants: z.array(syncedComponentVariantSchema).optional(),
  // ISS-5029: the desktop packer's honest "this identity has MORE retained
  // revisions than `variants` carries" marker, set where a per-family cap or the
  // per-component variant byte budget actually BOUND.
  //
  // Additive + optional, and all THREE states are distinct (whitlockk, #4391): a
  // marker-aware desktop sends `true` or `false` on every component, while a
  // desktop that predates the marker omits the key and thereby expresses no
  // opinion — the writer leaves the stored value untouched rather than clearing
  // a `true` an upgraded peer device recorded.
  variantsTruncated: z.boolean().optional(),
  // ISS-5029 (whitlockk, #4391): WHICH cap bound, ridden only with `true`. Kept as
  // an unconstrained string rather than a `z.enum` on purpose — this crosses a
  // repo boundary, `route.ts` safeParses the WHOLE batch, and an enum would let
  // one component carrying a future reason from a newer desktop reject up to 200
  // components on every retry. The reader maps an unrecognized value to "no
  // proof", which is the same safe default as absent. `.nullish()` rather than a
  // trimming helper so OMISSION survives parsing distinctly from an explicit
  // null — the value is a machine-generated identifier, so there is no
  // whitespace to normalize.
  variantsTruncatedReason: z.string().nullish(),
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
 * ISS-5029 (whitlockk, #4391): the object-level transform is where the variants cap
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
 *
 * `schemaVersion` is checked against the accepted SET, not the stamped version —
 * see `ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS`.
 */
export const desktopAgentComponentsPayloadSchema = z.object({
  schemaVersion: z.literal(ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS),
  batchId: z.string().uuid(),
  syncMode: z.enum(syncModeValues),
  componentCount: z.number().int().nonnegative(),
  // ISS-8051: DELIBERATELY UNBOUNDED, like every other array on this route. A
  // `.max()` here REJECTED the whole batch — the same blast radius the `variants`
  // comment above describes, one level up: a batch one component too long was
  // refused entire and refused again on every retry, with no per-component
  // salvage and no signal that anything was dropped. Admission control on THIS
  // route is `DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES` — its own flat,
  // non-gzip 256 KiB cap in `app/desktop/components/sync/route.ts`, NOT the
  // session route's gzip-ratio ceiling — enforced before parsing.
  components: z.array(syncedComponentSchema),
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
  // ISS-7259: this row is the session's first attributed skill. Must be declared
  // even though the schema is not `.strict()`: Zod STRIPS unknown keys by
  // default, so an undeclared field is dropped silently here rather than
  // rejected loudly, and the producer's own tests would never see it.
  // Additive/optional — an older desktop omits it entirely.
  isFirstAttributedSkill: z.boolean().optional(),
});

// FEA-2730 (G10): the desktop per-session analytics rollup, synced as-is. Token
// counts share the same 2^53 envelope; `startedDay` is a "YYYY-MM-DD" bucket
// string (not a full timestamp).
export const syncedAgentSessionAnalyticsSchema = z.object({
  startedAt: isoDateSchema.nullable().optional(),
  startedDay: nullableTrimmedStringSchema,
  // ISS-9434: deliberately a bare nullable string, NOT a `z.enum` over
  // `SESSION_STATUS`. The `sessions` array is unbounded (ISS-8051) and
  // `route.ts` safeParses the WHOLE batch, admitted by the pre-parse byte
  // budget `DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES`, so a rejecting bound
  // here would 400 every session in the request over one skewed row's rollup
  // copy. The narrowing happens at the write instead:
  // `persistSessionAnalytics` folds this through `normalizeSessionStatus`, which
  // fails open to `active`. Read that fold before widening or tightening this.
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
  // ISS-7813: `null` is a VALUE here, not an absence — the desktop's
  // `sessions.cost_usd_estimated` stores NULL for "nobody priced this", and the
  // cloud column is nullable so it can receive that unchanged. `.optional()`
  // alone admits only `undefined`, so a null would fail THIS field, fail its
  // session, and fail `parseDesktopAgentSessionsPayload` for the WHOLE batch.
  estimatedCostUsd: z.number().finite().nonnegative().nullable().optional(),
  runtimeMs: z.number().int().nonnegative().nullable().optional(),
  updatedAt: isoDateSchema.nullable().optional(),
});

export const sessionPrSchema = z.object({
  num: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
  title: z.string().trim().min(1),
  status: z.string().trim().min(1),
});

export const activityBucketSchema = z.object({
  label: z.string().trim().min(1),
  cIn: z.number().finite().nonnegative(),
  cOut: z.number().finite().nonnegative(),
  cCache: z.number().finite().nonnegative(),
  total: z.number().int().nonnegative(),
  toolStart: z.number().int().nonnegative(),
  tl0: z.number().int().nonnegative().nullable(),
  /*
   * ISS-10178: `protoSafeRecord`, not `z.record`. A model named `__proto__`
   * validates normally and is then swallowed by the inherited setter on the
   * plain `{}` result — no own key, no issue, `success: true` — so the bucket's
   * whole spend for that model is deleted on the ingest boundary. The key bound
   * below is the one `z.record` carried and must stay: dropping it would trade
   * one silent defect for another.
   */
  byModel: protoSafeRecord(
    z.string().trim().min(1),
    z.object({
      cIn: z.number().finite().nonnegative(),
      cOut: z.number().finite().nonnegative(),
      cCache: z.number().finite().nonnegative(),
    })
  ),
  /*
   * ISS-5819 review (whitlockk): the producer's own bin bounds. `.optional()`, so a
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
 * is a free string (taxonomy is desktop-owned; a label-set change is a
 * classifier-version bump, not a contract change). `evidenceLayers` are layer
 * NAMES only — no prose rides this lane. Unknown keys are stripped (forward
 * compat). The half-open span invariant `startMs < endMs` is enforced per row.
 */
export const syncedActivitySegmentRowSchema = z
  .object({
    phase: z.string().trim().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    confidence: z.number().finite().min(0).max(1),
    // ISS-8051: no cardinality bound — an extra layer name must not reject the
    // segment, the session, and the batch it rode in on.
    evidenceLayers: z.array(z.string().trim().min(1)),
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

export const syncedAgentSessionAgentSchema = z.object({
  externalAgentId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  subagentType: nullableTrimmedStringSchema,
  status: z.string().trim().min(1),
  currentTool: nullableTrimmedStringSchema,
  startedAt: isoDateSchema.nullable().optional(),
  updatedAt: isoDateSchema.nullable().optional(),
  endedAt: isoDateSchema.nullable().optional(),
  awaitingInputSince: isoDateSchema.nullable().optional(),
  parentExternalAgentId: nullableTrimmedStringSchema,
  metadata: optionalJsonObjectSchema,
});

/**
 * One confidence tier's spend: non-negative and inside `Decimal(14, 6)`.
 *
 * `.catch(null)` for the reason `syncedSessionActivityMetricsSchema` states: an
 * out-of-range tier degrades to "sent and impossible" instead of failing the
 * envelope around it.
 */
const tierSpendSchema = z
  .number()
  .finite()
  .min(0)
  .max(MAX_TIER_SPEND_USD)
  .nullish()
  .catch(null);

/** One whole, non-negative rollup count or version, bounded to the `int4` column. */
const rollupCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_ROLLUP_COUNT)
  .nullish()
  .catch(null);

/**
 * ISS-10721: the session activity-metrics rollup on the sync wire — autonomy
 * band, the spend split by attribution confidence, and the segment coverage
 * counts.
 *
 * Every key is `.nullish()`: a desktop build that computes only part of the
 * rollup must not lose the whole session, and an absent measure must survive as
 * ABSENT rather than becoming a measured zero. `autonomyBand` is a free string
 * here, not the `AutonomyBand` union — a newer producer's member degrades to
 * unknown at the read rather than rejecting the payload (the ISS-8051 lesson
 * applied to a vocabulary instead of a cardinality). Bounds are the honest ones
 * the column can hold: a ratio in [0, 1], non-negative finite money inside
 * `Decimal(14, 6)`, and whole non-negative counts inside the `int4` the four
 * count columns actually are.
 *
 * EVERY BOUND HERE DEGRADES, IT DOES NOT REJECT — `.catch(null)` per measure,
 * which is the same ISS-8051 lesson a third time. This schema validates the
 * whole envelope, so without it one malformed optional rollup from a
 * version-skewed producer fails `parseDesktopAgentSessionsPayload` and takes up
 * to 200 otherwise-valid sessions down with it, poison-retried on every attempt.
 * A caught value becomes `null` — "the producer SENT this and the boundary
 * judged it impossible" — which is exactly the distinction
 * `persistSessionActivityMetrics` keeps apart from an omitted measure, so the
 * bad measure alone is superseded and its siblings are written as sent.
 */
export const syncedSessionActivityMetricsSchema = z.object({
  autonomyBand: z.string().trim().min(1).nullish().catch(null),
  coverage: z
    .number()
    .finite()
    .min(COVERAGE_RATIO_RANGE.min)
    .max(COVERAGE_RATIO_RANGE.max)
    .nullish()
    .catch(null),
  spendLowConfUsd: tierSpendSchema,
  spendMediumConfUsd: tierSpendSchema,
  spendHighConfUsd: tierSpendSchema,
  segmentCount: rollupCountSchema,
  coveredSegmentCount: rollupCountSchema,
  classifierVersion: rollupCountSchema,
  metricVersion: rollupCountSchema,
});

// FEA-2718: synced events carry only columnar metadata. Conversation turn text
// (`summary`/`data`) is gone from the wire and the DB — the cloud transcript
// (FEA-2717) is the sole source of turn/tool detail.
//
// ISS-6886: leaving this `z.object` non-strict is the LOAD-BEARING half of v1
// acceptance, not defense-in-depth. A pre-FEA-2718 desktop still sends those two
// keys on every event; stripping them here, before any DB write, is what maps a
// v1 event onto the v2 columnar shape. `.strict()` would break every v1 client.
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

/**
 * ISS-7229 (davetho on #6406): a figure TOO WIDE FOR THE COLUMN drops the
 * field; it never fails it. Every other malformed shape still fails, exactly as
 * it did before — the two halves are deliberately not the same.
 *
 * The width bound was first written as `.lt(...)` on the field, with a comment
 * claiming that refusing it "lets the rest of the session land". It does not,
 * and this file says so twice already in other words: `route.ts` safeParses the
 * WHOLE batch, so one failing field returns 400 for every session in it — up to
 * 200 of them, none at fault — and returns it again on every retry, because the
 * desktop re-sends the same figure. An oversized cost is a REAL measurement that
 * merely does not fit; it must not take 199 innocent sessions down with it.
 *
 * Dropping leaves the key absent, which this field already defines as "no
 * opinion, keep what you have", so the column keeps whatever an earlier sync or
 * the ISS-12435 loop-event backfill put there. That is the honest answer — we
 * cannot store the number, so we decline to claim one — and it is the same
 * answer the shared constant's own docstring gives: rejected, not clamped,
 * because a clamped cost is a confident wrong measurement.
 *
 * `null`, negative, and non-finite keep FAILING, and that asymmetry is the
 * point. Those are a producer sending something no session ever legitimately
 * has, and the sibling test file records why each was made loud — a `null` in
 * particular is the one shape that could erase a real stored figure.
 * Width is the only case where a well-behaved desktop is right and the column is
 * simply too narrow, so it is the only case that degrades.
 */
const authoritativeCostUsdSchema = z
  .number()
  .finite()
  .nonnegative()
  .optional()
  .transform((value) =>
    value !== undefined && canStoreAuthoritativeCostUsd(value)
      ? value
      : undefined
  );

export const syncedAgentSessionSchema = z.object({
  externalSessionId: z.string().trim().min(1),
  name: nullableTrimmedStringSchema,
  // ISS-8717: the owner's rename, carried beside the collector's `name`.
  // Additive + optional — an older desktop omits it entirely, and the
  // PRESERVING helper keeps that omission rather than manufacturing a null, so
  // the parsed payload of an old client stays byte-equal to what it sent.
  // `upsertSessionSlice` writes only a present value, so neither absence nor an
  // explicit null can clear a rename made through `PATCH /agent-sessions/[id]`.
  // Bounded by the same shared ceiling that route's body uses so the two
  // boundaries cannot disagree about which renames are acceptable; over-long is
  // TRUNCATED rather than rejected, because a name is free-form display text
  // and refusing would park the whole session's sync behind it.
  nameOverride: optionalPreservedTrimmedStringSchema.transform((value) =>
    typeof value === "string"
      ? value.slice(0, AGENT_SESSION_NAME_MAX_CHARS)
      : value
  ),
  // ISS-10332: additive; seeds an artifact holding no priority, never clears one.
  priority: syncedPrioritySchema,
  createdAt: syncedSessionCreatedAtSchema,
  status: z.string().trim().min(1),
  // Per-session billing mode the desktop resolves from its local billing_mode
  // column (e.g. "api", "pro", "subscription_unknown"). Accepted opaquely and
  // additive — older desktop builds omit it. The usage cost split GROUPS BY it
  // to classify sessions, hence truncated.
  billingMode: truncatedBillingModeSchema,
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
  deviceTimeZone: ianaTimeZoneSchema,
  // ISS-4742: accepted only for desktop version skew. The cloud deliberately no
  // longer persists this Claude/session-level branch scalar; session→branch
  // association is the ArtifactLink lane.
  branch: optionalPreservedTrimmedStringSchema,
  prs: z.array(sessionPrSchema).nullish(),
  // ISS-4675: the three pre-formatted duration strings carry a LENGTH BOUND the
  // other free-form fields do not, and ISS-8051 deliberately KEPT it. Why it is
  // a VALUE DOMAIN rather than a payload-size cap is on the helper itself.
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
      source: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
  branchDiffStats: z
    .object({
      linesAdded: boundedLocFieldSchema,
      linesRemoved: boundedLocFieldSchema,
      filesChanged: boundedLocFieldSchema,
      source: z.string().trim().min(1),
    })
    .nullable()
    .optional(),
  turns: z.number().int().nonnegative().nullable().optional(),
  steeringEpisodes: z.number().int().nonnegative().nullable().optional(),
  autonomy: z.number().int().min(0).max(100).nullable().optional(),
  activityBuckets: z.array(activityBucketSchema).nullish(),
  // FEA-3568: raw activity-segment tiling (session_lis) replicated to the cloud.
  // Optional + additive — omission leaves previously persisted segments untouched
  // (mirrors tokenEvents/activityBuckets).
  //
  // ISS-8051: the cloud no longer bounds this. The desktop assembly still caps at
  // MAX_SYNCED_ACTIVITY_SEGMENTS and says so with the sibling
  // `activitySegmentRowsTruncated` flag below — that is a producer-side truncation
  // that MARKS ITSELF, which is the honest shape. The cloud's `.max()` was not
  // that: it rejected the session outright, so a producer that ever oversent lost
  // the whole session rather than a tiling suffix.
  activitySegmentRows: z.array(syncedActivitySegmentRowSchema).nullish(),
  // ISS-10721: the activity-metrics rollup (autonomy band / confidence spend
  // split / coverage counts). Optional + additive — omission leaves any
  // previously persisted rollup untouched, and never writes a zeroed one.
  activityMetrics: syncedSessionActivityMetricsSchema.nullish(),
  // FEA-3779: true when the raw tiling exceeded MAX_SYNCED_ACTIVITY_SEGMENTS and
  // activitySegmentRows was truncated by start order, so the cloud knows it holds
  // a partial tiling. Optional + additive (older desktop builds omit it → complete).
  activitySegmentRowsTruncated: z.boolean().nullish(),
  // ISS-7265: true when the desktop OMITTED the tiling from this payload to fit
  // the wire cap (distinct from the truncated-prefix signal above, where the
  // tiling is present but partial). Optional + additive — older desktop builds
  // omit it, which means nothing was stripped.
  activitySegmentRowsStripped: z.boolean().nullish(),
  // ISS-9859: marks a PR-list part of a sequence that paginates `prRefs` and
  // `prs`. `true` is a later page: merged into the stored PR links, its `prs`
  // appended to the stored blob. `false` is page 0: a whole-set replace the
  // freshness tie admits. Honored only on a chunk position a real sequence can
  // have (`isPrRefContinuationPart`, `isPaginatedPrListPageZero`). Sent only to
  // a server that advertised `agentSessionSyncPrRefChunking`.
  prRefsPaginated: z.boolean().nullish(),
  // ISS-8641 / ISS-8714: the top-level `metadata` keys ISS-7997's degrade held
  // back. A non-empty array declares the degradation AND names what is missing,
  // so the merge can tell "degraded away" from "the user deleted it". Optional +
  // additive — older desktop builds omit it, which keeps the wholesale replace.
  //
  // BOUNDED AT THE INGEST BOUNDARY, not trusted: the caller is any authenticated
  // client and this array is read into a merge that reinstates stored keys. The
  // bound is CARDINALITY and it is the compaction contract's own cap rather than
  // a new number — a persisted blob cannot hold more than `MAX_METADATA_KEYS`
  // top-level keys, so a longer list could only be noise or an amplification
  // attempt.
  //
  // NO PER-KEY LENGTH BOUND, deliberately, and an earlier revision's
  // `MAX_METADATA_STRING_CHARS` here was a real defect (review:
  // chatgpt-codex-connector). That cap bounds string VALUES; the shared compactor
  // never bounds a key NAME, so it retains a 2,000-character key verbatim and the
  // producer can then legitimately declare it. Rejecting the element dropped the
  // WHOLE list — the blast radius is every withheld key, not the long one — which
  // falls back to the wholesale replace this field exists to prevent. The
  // admission rule has to be "every key the producer can retain"; the request's
  // own size limit is what bounds the bytes.
  //
  // A VIOLATION DROPS THE HINT, never the session (`.catch`): the field becomes
  // absent, which is exactly an older build's payload and therefore falls back to
  // today's wholesale replace. Rejecting would cost the whole session over a
  // hint — `activitySegmentRows`' ISS-8051 lesson — and throwing on a peer
  // version's payload is what the cross-repo rule forbids outright.
  metadataWithheldKeys: z
    .array(z.string())
    .max(MAX_METADATA_KEYS)
    .nullish()
    .catch(undefined),
  span: sessionSpanSchema.nullish(),
  markers: z.array(sessionMarkerSchema).nullish(),
  throttles: z.array(sessionThrottleSchema).nullish(),
  tracePhaseSources: z.array(sessionTracePhaseSourceSchema).nullish(),
  throttleSources: z.array(sessionTraceThrottleSourceSchema).nullish(),
  correctionSources: z.array(sessionTraceCorrectionSourceSchema).nullish(),
  // FEA-2563 widened this from `.max(50)` to the `phaseSources` limit after a
  // phase-cycling session with >50 distinct phases dropped the entire batch of
  // up to 200 sessions. ISS-8051 finishes that thought: widening a rejection
  // only moves the cliff, so the bound is gone.
  //
  // NOT removed here, and NOT thereby blessed: the batch `superRefine` below
  // still REJECTS a session whose three trace-source arrays exceed
  // `SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes` in total. That is the
  // same reject-the-whole-thing shape wearing a byte budget instead of a
  // `.max()`. It is outside this change's enumerated scope and reported on
  // ISS-8051 rather than quietly left. So is `tokenEvents` below, whose own
  // `.max()` goes in the sibling change — neither is the last standing
  // rejection, and this comment does not claim otherwise.
  phases: z.array(sessionPhaseSchema).nullish(),
  phaseIterations: z.record(z.string(), z.number().int().positive()).nullish(),
  phaseLoopbacks: z.array(phaseLoopbackSchema).nullish(),
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
  // FEA-3595 bounded this field at the ingress; ISS-8271 moved the bound to the
  // apply. Schema-level rejection here is batch-wide (see the ISS-8051 header
  // note) and deterministic: one out-of-window value — a desktop sentinel
  // (`-1` import-pending / `0` maintenance-stale) or a newer build's too-new
  // revision — 400'd up to 200 sessions on every retry, the desktop
  // dead-lettered them keyed on session id alone, and the reseal that heals the
  // row emits no sync signal, so the sessions stranded. The apply
  // (`resolveWireDataRevisionDisposition`) now decides per session: sentinel 0
  // folds to "no revision", -1/too-new are held (nothing written, id left out
  // of `persistedSessionIds` for the ack_omitted re-send). A value outside
  // [1, MAX_SUPPORTED_DATA_REVISION] can no longer reach the revision gate or
  // the column, so FEA-3595's irreversible-high-water-mark poison guarantee
  // survives without the rejecting cap.
  // ISS-7229: Claude's own reported cost, summed by the desktop from its OTel
  // capture table. `.optional()` WITHOUT `.nullable()`, unlike its
  // `sessionAnalytics.estimatedCostUsd` neighbour, and the asymmetry is load-
  // bearing: the cloud column also holds figures this payload did not write (the
  // ISS-12435 loop-event backfill), so accepting a `null` would let a desktop
  // with no OTel capture erase one. Absence means "no opinion, keep what you have". A
  // desktop that sends `null` anyway fails THIS field rather than silently
  // clearing the column — which is the loud direction to fail in.
  // ISS-7229 (whitlockk + marisolashgrove on #6393): bounded at the STORAGE limit, not
  // just at zero. `session_detail.authoritative_cost_usd` is `Decimal(14, 6)`,
  // which tops out below 1e8, so a larger figure raises 22003 at the driver,
  // inside the slice transaction, taking the whole session's upsert with it and
  // failing identically on every later sync. `authoritativeCostUsdSchema` DROPS
  // an unstorable figure rather than failing the field — see its own note for
  // why the difference is the whole point.
  authoritativeCostUsd: authoritativeCostUsdSchema,
  dataRevision: z.number().int().nullish(),
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
  operationEvidence: syncedOperationEvidenceSchema,
  // Forward compat (FEA-2729): a ref whose explicit `kind` is unknown to this
  // contract version is dropped rather than failing the whole payload. Legacy
  // refs (no `kind`) and known kinds still undergo strict validation — so an
  // invalid slug on a known kind is still rejected.
  artifactRefs: z
    .preprocess(
      filterForwardCompatibleArtifactRefs,
      z.array(syncedArtifactRefSchema).optional()
    )
    .optional(),
  prRefs: z
    .preprocess(
      dropOversizedSessionPrRefs,
      z.array(syncedSessionPrRefSchema).optional()
    )
    .optional(),
  agents: z.array(syncedAgentSessionAgentSchema),
  events: z.array(syncedAgentSessionEventSchema),
  tokenUsageByModel: z.array(syncedAgentSessionTokenUsageSchema),
  // FEA-2730: additive optional sections. Absence means "no replacement data"
  // (the service leaves previously persisted rows untouched); an explicit empty
  // tokenEvents array is a legitimate no-op.
  //
  // ISS-8051: DELIBERATELY UNBOUNDED. `MAX_SYNCED_TOKEN_EVENTS_PER_SESSION`
  // (10,000) used to cap this array, and a `.max()` on a Zod array REJECTS — it
  // does not truncate. `route.ts` safeParses the WHOLE payload, so a session
  // holding one token event too many failed validation entirely and was dropped,
  // taking its events, agents, metadata and tiling with it, and re-dropping on
  // every retry with no signal that anything was lost. The desktop producer never
  // knew the ceiling existed (the constant had zero references in `apps/desktop`),
  // so it kept building payloads the cloud had to refuse. What bounds the count
  // now is the request: `readBoundedMaybeGzipJsonBody` refuses a body expanding
  // past `SYNC_DECOMPRESSED_BYTE_CEILING` (16 MiB) before parsing. Persistence is
  // NOT streaming — `dedupeTokenEvents` materializes the whole array into a Map
  // before `TOKEN_EVENT_WRITE_CHUNK_SIZE` chunking begins — so that request
  // ceiling, not this validator, is what holds the array size down. Do not
  // reintroduce a cardinality bound here.
  tokenEvents: z.array(syncedAgentSessionTokenEventSchema).optional(),
  sessionAnalytics: syncedAgentSessionAnalyticsSchema.nullish(),
  // T-7.7 / AC-011: per-component usage metrics for this session. Optional +
  // additive — older desktop builds omit it; omission leaves previously
  // persisted `agent_component_session_usage` rows untouched.
  components: z.array(syncedComponentUsageSchema).optional(),
});

// The FEA-4022 frustration and ISS-4586 ends_with_error keys-covered guards
// live in `desktop-agent-sessions-schema-guards.ts` with the other
// compile-time guards.

/**
 * The batch id's shape, shared by the full payload schema below and by
 * {@link readDesktopAgentSessionsBatchId}, so the cheap pre-rate-limit read and
 * the full parse can never disagree about what a valid join key is.
 */
const desktopAgentSessionsBatchIdSchema = z.string().uuid();

/**
 * The batch id alone, as a body envelope. Non-strict and single-keyed on
 * purpose: it reads the one declared field and ignores every other top-level
 * key, so it stays O(1) in the payload's real size.
 */
const desktopAgentSessionsBatchIdEnvelopeSchema = z.object({
  batchId: desktopAgentSessionsBatchIdSchema,
});

export const desktopAgentSessionsPayloadObjectSchema = z.object({
  schemaVersion: acceptedBatchSchemaVersionSchema,
  batchId: desktopAgentSessionsBatchIdSchema,
  syncMode: z.enum(syncModeValues),
  sessionCount: z.number().int().nonnegative(),
  // ISS-8051: unbounded, like every array below it. The batch size the server
  // actually admits is the route's byte budget
  // (`DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES`, enforced before parsing),
  // which the sync-limits module already calls "the real admission control"
  // that "ends nearly every batch first" — this `.max()` was a second ceiling
  // whose only reachable effect was to 400 a batch the byte budget had let in.
  sessions: z.array(syncedAgentSessionSchema),
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
  // ISS-7516: the sending machine's data-sync level, batch-level because it is a
  // property of the device rather than of any one session. Optional + additive:
  // an older desktop omits it and the column stays NULL, which the read side
  // serves as `undefined` ("no level reported"), never as a level. MUST be
  // declared here rather than left to be stripped — this schema is deliberately
  // non-strict, so an undeclared field is dropped before persistence with no
  // rejection and no log (the ISS-4586 class; see `dataSyncLevelKeyCovered`).
  dataSyncLevel: z.nativeEnum(DataSyncLevel).optional(),
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
      diagnostics?: DesktopAgentSessionsPayloadDiagnostic[];
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
  const diagnostics = collectOversizedPullRequestRefDrops(sanitizedPayload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: summarizeParseIssues(parsed.error.issues),
    };
  }

  return {
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
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
      // ISS-7516: preserve the sending machine's data-sync level when present
      // (omit when absent — additive, no `null` for a missing optional field).
      //
      // This projection is a SECOND strip point, independent of the schema: a
      // field declared on the Zod object but not copied here is validated and
      // then dropped anyway, and `dataSyncLevelKeyCovered` does NOT catch that —
      // it proves the schema knows the key, not that the parse result carries
      // it. The boundary test asserts the parsed VALUE for exactly this reason.
      ...(parsed.data.dataSyncLevel === undefined
        ? {}
        : { dataSyncLevel: parsed.data.dataSyncLevel }),
    },
  };
}

// The goal-stage-2 `wantsAcceptedSessionIds` keys-covered guard lives in
// `desktop-agent-sessions-schema-guards.ts` with the other compile-time guards.

/**
 * ISS-5029 (whitlockk, #4391): enforce {@link SYNCED_COMPONENT_VARIANTS_MAX} on an
 * incoming component AND say so on the same object.
 *
 * The cap TRUNCATES rather than rejects, for the reason spelled out on the
 * `variants` field: `route.ts` safeParses the whole batch with no per-component
 * salvage, so a `.max()` here would let one pathological component reject every
 * other component in the batch on every retry. But truncating on the field alone left the write
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

/**
 * Read ONLY the batch id off an unvalidated request body (ISS-7227).
 *
 * The handler rate-limits before it parses, so a throttled request never
 * reaches {@link parseDesktopAgentSessionsPayload} — and `rate_limited` is
 * precisely a rejection the desktop DOES record against its batch id, so a
 * recorder placed after the limiter leaves the throttled failure population
 * unjoinable. This is the fixed-size half of that parse: one declared property
 * plus a UUID check, no sanitize traversal and no per-session walk, so it can
 * run ahead of the limiter without handing an abusive target the O(payload)
 * cost the limiter exists to withhold.
 *
 * Total: a non-object body, an absent id, and any value that is not a UUID all
 * resolve to `undefined`, so such a request is attributed by omission rather
 * than by a guessed or unvalidated id.
 */
export function readDesktopAgentSessionsBatchId(
  payload: unknown
): string | undefined {
  const parsed = desktopAgentSessionsBatchIdEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data.batchId : undefined;
}
