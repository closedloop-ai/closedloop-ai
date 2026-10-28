import { z } from "zod";
import {
  type SyncTelemetryAttributes,
  TelemetryAttribute,
} from "./src/attributes";
import {
  boundedText,
  TELEMETRY_UUID_PATTERN,
  TelemetryTextMaxLength,
} from "./src/schema-primitives";

/**
 * FEA-3426: closed set of reasons a sync batch was a `failure` or `dead_letter`.
 * The SSOT for the `sync.reason` attribute values. Defined as literals here (not
 * imported from `DesktopAgentSessionsAckReason`) because this is a leaf package
 * and the two same-named ack-reason consts disagree — the desktop protocol one
 * carries `ack_timeout` (locally synthesized) while the shared API one does not.
 * The union is the desktop ack reasons plus the locally-synthesized non-ack
 * producers: `transport_error` (a thrown send), `locally_oversized` (a payload
 * still over the cap after chunking), `unhydratable` (a candidate whose local
 * row was deleted after enqueue), and the goal-stage-2 pair described below.
 * Transport-health only — never ids or content.
 *
 * FEA-3425 adds the two reasons the HTTP sync transport synthesizes locally:
 * `unauthenticated` (401 / no session token — the lane defers with budgets
 * intact) and `target_not_owned` (coded 403 — the sent computeTargetId is not
 * owned by the authenticated identity).
 *
 * FEA-3792 (PRD-536 D9): `transport_unavailable` was split out of the overloaded
 * `rate_limited` — the desktop client returns it (never the server) when the
 * relay is not ready / the socket disconnected after the batch was prepared. It
 * is a distinct `sync.reason` so the SLO can separate a local relay flap from a
 * genuine server throttle instead of reverse-engineering the cause.
 *
 * ISS-5088 adds `transport_timeout`: a client-side request abort where the
 * server never answered, split out of `ack_timeout` (which now means only a
 * server-answered HTTP 408). They are distinct `sync.reason` values because they
 * have opposite blame — `ack_timeout` is attributable to the batch, while
 * `transport_timeout` is a lane-wide local/network stall — and the SLO must be
 * able to separate "our payloads are too slow" from "this desktop lost its
 * network" without inferring it from a correlated socket disconnect.
 *
 * Goal stage 2 (atomic row-level ack) adds two locally-synthesized reasons:
 * `ack_clear_failed` — the server acked the batch but the local durable
 * outbox clear failed to commit (db-host down), so ack processing was aborted
 * and the rows stay queued for a deduped re-send; this is what makes the
 * bounded "re-send of a cloud-persisted row" measurable instead of silent.
 * `ack_omitted` — the server's accepted-batch echo (`acceptedSessionIds`)
 * omitted a sent row; the lane is provably healthy (neighbors acked in the
 * same request), so the omission burns a bounded row-attributable budget.
 *
 * ISS-6338 extends the set to the reasons the OTHER four lanes produce and
 * lane 1 does not, rather than folding them onto a lane-1 spelling that means
 * something else: `protocol_unsupported`, `session_missing`, `part_conflict` and
 * `generation_conflict` come from the invocation-parts lane, and
 * `upload_conflict` / `source_missing` from the transcript archive lane. Folding
 * `part_conflict` into `validation_failed` would erase exactly the distinction an
 * incident is debugged on (`main/sync/AGENTS.md`, "No merged status
 * vocabularies").
 *
 * ISS-9418 adds `lane_gave_up`: the wire-legal spelling of a lane that crossed
 * its 24h ENVIRONMENTAL wall clock and stopped attempting. Until now a 24h
 * give-up and an ordinary budget exhaustion were the SAME span - the session
 * lane's `*_lane_stalled` distinction lives only in the durable `last_error`
 * column, which never reaches `sync.reason` because that attribute is a closed
 * enum and no member spelled it.
 *
 * LANDED RECEIVER-FIRST, WITH NO DESKTOP SPAN PRODUCER IN THE SAME CHANGE, and
 * that is deliberate rather than an oversight. {@link SyncTelemetrySchema} is
 * `.strict()` over `z.enum(SyncReason)`, so a value the receiving side has not
 * learned yet does not lose one field - it rejects the WHOLE span, and the batch
 * it described disappears from the SLO instead of being labelled coarsely.
 * Desktop and cl-api deploy independently, so the member has to be deployed
 * before anything emits it (`docs/runbooks/backward-compatible-api-contracts.md`).
 * The give-up is NOT unobserved in the meantime: the desktop reports it on the
 * `sync.lane.gave_up` telemetry category, whose own reason field carries the
 * ENVIRONMENTAL cause (`ingestion_failed`, `rate_limited`, ...) and whose
 * receiving vocabulary is tolerant by construction. Putting this value on the
 * span belongs to ISS-9884, which owns the cloud-facing half of the give-up.
 *
 * ISS-11389 adds `local_read_failed`: the cause of a lane-wide give-up reached
 * because a LOCAL store read kept failing. It has no span producer either; it
 * rides only the tolerant `sync.lane.gave_up` reason and the durable
 * `lane_gave_up_reason` column.
 */
export const SyncReason = {
  AckClearFailed: "ack_clear_failed",
  AckOmitted: "ack_omitted",
  AckTimeout: "ack_timeout",
  GenerationConflict: "generation_conflict",
  PartConflict: "part_conflict",
  ProtocolUnsupported: "protocol_unsupported",
  RateLimited: "rate_limited",
  SessionMissing: "session_missing",
  SourceMissing: "source_missing",
  TransportTimeout: "transport_timeout",
  TransportUnavailable: "transport_unavailable",
  IngestionFailed: "ingestion_failed",
  UploadConflict: "upload_conflict",
  ValidationFailed: "validation_failed",
  FeatureDisabled: "feature_disabled",
  LocallyOversized: "locally_oversized",
  TargetNotOwned: "target_not_owned",
  TransportError: "transport_error",
  Unauthenticated: "unauthenticated",
  Unhydratable: "unhydratable",
  LaneGaveUp: "lane_gave_up",
  LocalReadFailed: "local_read_failed",
} as const;

/** Literal union of `sync.reason` values. */
export type SyncReason = (typeof SyncReason)[keyof typeof SyncReason];

/**
 * ISS-6338: which desktop→cloud sync state machine produced the
 * batch. Closed by construction — a lane name is never interpolated from a
 * variable, so this attribute can carry no free text.
 *
 * Spelled as literals here for the same reason {@link SyncReason} is: this is a
 * leaf package and cannot import the desktop's `SyncLaneId`. The two are held
 * equal by `apps/desktop/test/sync-lane-cloud-health.test.ts`, which CAN see
 * both — a drift guard, not a second source of truth.
 */
export const SyncLane = {
  SessionMetadata: "session_metadata",
  InvocationParts: "invocation_parts",
  TranscriptArchive: "transcript_archive",
  ComponentInventory: "component_inventory",
  TraceComments: "trace_comments",
} as const;

/** Literal union of `sync.lane` values. */
export type SyncLane = (typeof SyncLane)[keyof typeof SyncLane];

/**
 * How a sync batch settled. Named here as the sibling of {@link SyncLane} and
 * {@link SyncReason} rather than left as an inline `z.enum([...])`, because
 * ISS-7497 gave the values a second reader — {@link SyncBatchCounterSchema} —
 * and two inline copies of a closed set is how the span and the counter would
 * come to disagree about what a batch outcome is.
 */
export const SyncOutcome = {
  Success: "success",
  Failure: "failure",
  DeadLetter: "dead_letter",
} as const;

/** Literal union of `sync.outcome` values. */
export type SyncOutcome = (typeof SyncOutcome)[keyof typeof SyncOutcome];

/**
 * ISS-7248: how the payload that failed had been RESHAPED to fit the wire cap.
 *
 * A silently oversized or partially-shipped payload is the leading suspect for a
 * server-side 500 that carries no cause, and until now nothing on the wire could
 * tell a whole batch apart from one chunk of a split session — the two have
 * identical `sync.payload_bytes` by construction, because chunking exists to make
 * them identical. Closed by construction, so this attribute can carry no free
 * text and no id.
 *
 * `ChunkTailDiscarded` is deliberately NOT a synonym for `ChunkedTail`: it names
 * the case where the failure ALSO threw away the pinned remainder, which is the
 * difference between "one chunk of this session failed" and "this session's whole
 * in-flight sequence was abandoned and will re-prepare from chunk 0".
 *
 * ISS-7265: `TilingStripped` is the only member reporting DEGRADED CONTENT
 * rather than a chunk position. The others describe a payload that is whole once
 * its parts are reassembled; this one describes a part that was never sent. One
 * slot cannot carry both axes, so a stripped payload that is ALSO chunked reports
 * this value here and its masked position in the durable record's own
 * `chunkPosition` field — a reader of this attribute alone cannot recover it.
 */
export const SyncPayloadShaping = {
  Whole: "whole",
  ChunkedHead: "chunked_head",
  ChunkedTail: "chunked_tail",
  ChunkTailDiscarded: "chunk_tail_discarded",
  TilingStripped: "tiling_stripped",
} as const;

/** Literal union of `sync.payload_shaping` values. */
export type SyncPayloadShaping =
  (typeof SyncPayloadShaping)[keyof typeof SyncPayloadShaping];

/**
 * PLN-2028 D1 (ISS-10043): WHICH producer wrote a lane's durable give-up.
 *
 * There is one give-up per (lane, compute target), so this is a field ON that
 * record and not a second give-up. The two producers make opposite claims about
 * the same lane: an environmental gate says the WORLD was broken for it for a
 * day and the lane is terminal, while a per-row ceiling says enough individual
 * rows exhausted their own budgets while the lane kept attempting. A lane with
 * both — {@link SyncLane.SessionMetadata} — is one a query grouped by `lane`
 * alone cannot read, because it puts a terminal outage and a routine ceiling in
 * one bucket.
 *
 * Declared HERE rather than mirrored, unlike {@link SyncLane} and
 * {@link SyncReason} above: those have a desktop owner this leaf package cannot
 * import, and this one has none. Both readers derive from this const — the
 * desktop's producer policy and the cloud's wire schema — so the vocabulary
 * cannot drift between the process that writes a producer and the one that
 * groups by it.
 */
export const LaneGiveUpSource = {
  EnvironmentalGate: "environmental_gate",
  RowCeiling: "row_ceiling",
} as const;

/** Literal union of `syncLaneGaveUp.source` values. */
export type LaneGiveUpSource =
  (typeof LaneGiveUpSource)[keyof typeof LaneGiveUpSource];

/**
 * The per-attribute validators, declared apart from {@link SyncTelemetrySchema}
 * so the `satisfies` below can hold them against the attribute group.
 *
 * ISS-7496: that guard is the point. This object is the STRICT boundary a sync
 * span crosses, and a `.strict()` object rejects the WHOLE record on an
 * unrecognised key — so an attribute added to `SyncTelemetryAttributes` and not
 * taught here would not lose one field, it would silently drop every span that
 * carried it. Requiring a validator per group member makes that a `tsc` failure
 * in this file instead of a production hole nothing observes.
 */
const SyncTelemetryShape = {
  [TelemetryAttribute.SyncEvent]: z.enum(["batch"]).optional(),
  [TelemetryAttribute.SyncOutcome]: z.enum(SyncOutcome).optional(),
  [TelemetryAttribute.SyncPayloadBytes]: z.number().int().min(0).optional(),
  [TelemetryAttribute.SyncLatencyMs]: z.number().finite().min(0).optional(),
  [TelemetryAttribute.SyncReason]: z.enum(SyncReason).optional(),
  [TelemetryAttribute.SyncLane]: z.enum(SyncLane).optional(),
  [TelemetryAttribute.SyncDeadLetteredCount]: z
    .number()
    .int()
    .min(0)
    .optional(),
  // ISS-7248: the client-generated batch id the sync request body already
  // carries, so the desktop-side failure record and the server-side span can
  // name the same attempt. Constrained to the UUID SHAPE rather than typed as
  // free text: a value that must match this pattern cannot smuggle a session
  // id, a path, or transcript text onto the wire. Expressed as a `pattern`
  // (not zod's `uuid()`) because the generated JSON Schema is validated by an
  // ajv instance with no `uuid` format registered, which rejects the schema
  // outright rather than the value.
  [TelemetryAttribute.SyncBatchId]: z
    .string()
    .regex(TELEMETRY_UUID_PATTERN)
    .optional(),
  [TelemetryAttribute.SyncSessionCount]: z.number().int().min(0).optional(),
  // 1-indexed: the first failure of a batch is attempt 1, so `> 1` is exactly
  // "this is a retry". Omitted rather than defaulted when the failure class
  // burns no retry budget and there is therefore no attempt count to report.
  [TelemetryAttribute.SyncAttempt]: z.number().int().min(1).optional(),
  [TelemetryAttribute.SyncPayloadShaping]: z
    .enum(SyncPayloadShaping)
    .optional(),
  // ISS-7265: sessions in the batch that shipped WITHOUT their activity
  // tiling. A count, not a flag, and separate from `payload_shaping` because
  // that attribute has one slot: a strip co-occurring with an abandoned chunk
  // sequence reports the sequence, and this is then the only degradation
  // signal on the span. Omitted when nothing was stripped.
  [TelemetryAttribute.SyncTilingStrippedCount]: z
    .number()
    .int()
    .min(0)
    .optional(),
  // ISS-7496: age of the freshest session the server CONFIRMED, in whole ms.
  // Omitted — never zeroed — when nothing was confirmed, when the delivery was
  // a non-final chunk, or when no delivered row carried a readable timestamp:
  // a `0` here reads as "the cloud is perfectly current", which is the exact
  // reassuring lie a freshness measure exists to prevent.
  //
  // BEFORE BUILDING AN ALARM ON THIS, read the attribute's own entry in
  // `CompatibilityAttributeProducerMapping` (`src/attribute-producer-mapping.ts`): these spans
  // are tail-sampled at `CollectorTailSamplingPolicy.baselineSamplingPercentage`
  // while failures are kept whole, so a threshold alarm on the MINIMUM lag is
  // not sound. Trend and high-percentile reads are.
  [TelemetryAttribute.SyncFreshestSessionLagMs]: z
    .number()
    .int()
    .min(0)
    .optional(),
  // ISS-7220: one of the two non-`sync.*` keys this strict schema admits (the
  // other is `app.operating_mode` below, which exists to make an ABSENT value
  // of this one readable). Without it a dead-letter count is attributable to
  // a lane but to no tenant, because
  // `app.organization.id` rides the desktop activity ROOT span and a
  // `sync.batch` child cannot be grouped by a parent's attribute — so "DLQ
  // depth by lane and org" was unanswerable from the child alone. Reuses the
  // already-published attribute rather than a `sync.*` alias, for the reason
  // ISS-7221 gave the cl-api request emitter the same name: one spelling is
  // what makes a desktop record and the server span it produced joinable.
  // Bounded id only — never an org NAME (the producer reads `organizationId`
  // from `GET /me` and retains nothing else).
  [TelemetryAttribute.AppOrganizationId]: boundedText(
    TelemetryTextMaxLength.AppOrganizationId
  ).optional(),
  // ISS-7220: what makes an ABSENT org readable. A multiplayer install whose
  // background `GET /me` has not resolved yet omits the org exactly as a
  // single-player install does, and those two mean opposite things to a
  // DLQ-by-org rollup: "this tenant's, not yet attributed" against "no tenant
  // exists". The activity root span is legible only because it carries this
  // attribute beside the org; the child needs it for the same reason, and
  // without it the unattributed bucket silently mixes the two. The collapse
  // is correlated with what is being measured — an unreachable cloud API both
  // dead-letters batches and leaves `/me` unresolved — so the batches most
  // worth attributing are the ones most likely to arrive bare.
  [TelemetryAttribute.AppOperatingMode]: z
    .enum(["single_player", "multiplayer"])
    .optional(),
} satisfies Record<
  (typeof SyncTelemetryAttributes)[number],
  z.ZodType<unknown, unknown>
>;

/** Strict sync attribute schema for transport-health telemetry only. */
export const SyncTelemetrySchema = z.object(SyncTelemetryShape).strict();

/** Parsed sync telemetry attribute shape. */
export type SyncTelemetry = z.infer<typeof SyncTelemetrySchema>;

/**
 * ISS-7497: the name of the sync batch COUNTER — a metric, deliberately not a
 * span attribute.
 *
 * The `sync.batch` span cannot answer "what fraction of batches succeed". It is
 * a child of the desktop activity-window root, and the collector's
 * `tail_sampling` decides per trace: a failed batch sets span status ERROR and
 * is retained whole, while a successful one falls to
 * `CollectorTailSamplingPolicy.baselineSamplingPercentage`. That makes the
 * failure numerator complete and the success denominator a sample, so a rate
 * read off spans is not noisy but directionally wrong.
 *
 * `tail_sampling` is trace-only. A counter is aggregated in-process and shipped
 * by the periodic metric reader, so every batch is counted regardless of what
 * happens to its span — which is what makes a rate computed from this instrument
 * correct rather than merely askable. Spans stay the per-batch forensic record;
 * this is the population.
 */
export const SyncBatchCounterName = "sync.batch.count";

/**
 * Attributes the counter carries: the two dimensions a rate is sliced by, and
 * nothing else. Kept deliberately narrow — a counter's cardinality is its cost,
 * and an id or a byte count here would multiply the time series without making
 * any rate answerable. Both validators are the SAME closed sets the span shape
 * uses, so a lane or outcome cannot mean one thing on the span and another on
 * the counter.
 *
 * `sync.outcome` is REQUIRED here, unlike on the span: an increment that cannot
 * say which way the batch went contributes to neither numerator nor denominator
 * and would silently deflate the rate it exists to make correct.
 */
const SyncBatchCounterShape = {
  [TelemetryAttribute.SyncOutcome]: z.enum(SyncOutcome),
  [TelemetryAttribute.SyncLane]: z.enum(SyncLane).optional(),
} satisfies Record<string, z.ZodType<unknown, unknown>>;

/** Strict attribute schema for the sync batch counter. */
export const SyncBatchCounterSchema = z.object(SyncBatchCounterShape).strict();

/** Parsed sync batch counter attribute shape. */
export type SyncBatchCounter = z.infer<typeof SyncBatchCounterSchema>;

/**
 * ISS-9246: the per-lane desktop sync BURN-DOWN gauges — the device's own answer
 * to "how much is still owed to the cloud, and how far behind am I".
 *
 * Promoted from `gatewayLog` (ISS-5387 built the measurement and left it
 * log-only, which reaches only whoever is already sitting at that machine).
 * These are METRICS rather than span attributes for the same reason
 * {@link SyncBatchCounterName} is: `tail_sampling` is trace-only, and a backlog
 * read off sampled spans is a sample of a population, not the population.
 *
 * DEVICE-REPORTED, AND THEREFORE ON THE DEVICE'S OWN CLOCK. This is the axis
 * that separates these gauges from the server-stamped `session.ingestion.*` pair
 * (`apps/api/app/cron/sample-session-ingestion-health/service.ts`), whose two
 * timestamps are both taken inside the accepted-batch transaction and are
 * therefore single-clock and skew-proof. {@link SyncBurndownGaugeName.OldestPendingAgeMs}
 * is a `now - enqueued_at` subtraction taken entirely on the device, so it is
 * immune to server skew and exposed to a device clock STEP. The two signals are
 * complements, not substitutes: the cloud can only see what arrived, and backlog
 * depth is a property of what has not.
 *
 * ## Absent is not zero
 *
 * A figure the device did not measure is NOT recorded — never recorded as `0`.
 * The producer (`apps/desktop/src/main/telemetry/sync-burndown-gauges.ts`) states
 * per figure what makes it unmeasured, and the desktop burn-down contract already
 * models the distinction (`SyncLaneDeadLetteredBasis.Unmeasured` against
 * `NoDeadLetterState` is exactly "nobody looked" against "this lane structurally
 * cannot have any").
 */
export const SyncBurndownGaugeName = {
  /** Items the lane would actually deliver. A measured `0` means drained. */
  ItemsRemaining: "sync.burndown.items_remaining",
  /** Age of the oldest item still owed, in whole ms, on the DEVICE's clock. */
  OldestPendingAgeMs: "sync.burndown.oldest_pending_age_ms",
  /** Items the lane is holding abandoned AT THIS SAMPLE. Not a cumulative loss tally. */
  DeadLettered: "sync.burndown.dead_lettered",
} as const;

/** Literal union of burn-down gauge names. */
export type SyncBurndownGaugeName =
  (typeof SyncBurndownGaugeName)[keyof typeof SyncBurndownGaugeName];

/**
 * Attributes every burn-down gauge carries: the lane, and nothing else.
 *
 * Deliberately narrow, for the reason {@link SyncBatchCounterShape} is: a
 * gauge's cardinality is its cost. `sync.lane` is REQUIRED — a depth that cannot
 * say which lane owes it is not actionable, and summing it across lanes is
 * meaningless because the lanes count incompatible populations.
 *
 * Reuses the SAME closed `sync.lane` set the span and the batch counter use, so
 * a lane cannot mean one thing on a burn-down gauge and another on a batch. That
 * reuse is also why this needed no new `TelemetryAttribute` and therefore no
 * collector re-vendoring hop: `sync.lane` is already in `vendoredKeys`.
 */
const SyncBurndownGaugeShape = {
  [TelemetryAttribute.SyncLane]: z.enum(SyncLane),
} satisfies Record<string, z.ZodType<unknown, unknown>>;

/** Strict attribute schema for the burn-down gauges. */
export const SyncBurndownGaugeSchema = z
  .object(SyncBurndownGaugeShape)
  .strict();

/** Parsed burn-down gauge attribute shape. */
export type SyncBurndownGauge = z.infer<typeof SyncBurndownGaugeSchema>;
