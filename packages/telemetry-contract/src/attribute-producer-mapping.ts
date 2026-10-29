/**
 * @file attribute-producer-mapping.ts
 * @description The producer inventory for every ClosedLoop compatibility
 * attribute: which code emits it, off which field, and why no pinned OTel
 * semantic convention owns it.
 *
 * Split out of `attributes.ts` (ISS-6336), which crossed the 1,000-line ceiling
 * once this group grew past the attribute NAMES it documents. Prose, not
 * contract surface — nothing here is read at runtime; the `satisfies Record<...>`
 * is what makes a new compatibility attribute without a stated producer a
 * compile error, and that guard travels with the map.
 */
import {
  type ClosedLoopCompatibilityAttribute,
  TelemetryAttribute,
} from "./attributes.js";

/** Producer inventory explaining each compatibility attribute source. */
export const CompatibilityAttributeProducerMapping = {
  [TelemetryAttribute.AppOrganizationId]: {
    producer:
      "apps/desktop/src/main (desktop OTel SDK, FEA-1996) and apps/api/lib/route-utils.ts (cl-api request spans, ISS-7221)",
    sourceField: "organizationId",
    reason:
      "The authenticated organization id, attached as a ClosedLoop compatibility field (multiplayer attribution); there is no pinned OTel semantic convention for organization identity. ISS-7221 gave the cl-api request emitter the SAME attribute name rather than a second spelling, because that is what makes a desktop record and the server span it produced joinable — a per-side name would have left blast radius unanswerable, which was the whole defect. Only ever set when the request actually authenticated: an anonymous or rejected request omits it.",
  },
  [TelemetryAttribute.AppClientVersion]: {
    producer:
      "apps/desktop/src/main (first-party cloud request headers, ISS-8749) via apps/api/lib/auth (cl-api request spans)",
    sourceField: "clientVersion",
    reason:
      "The Desktop build that made the call, attested by the caller in the `x-desktop-client-version` request header and recorded on the API request span. Explicitly client-scoped rather than folded into `service.version`, which on an API span already names the API's own build (`resolveServerVersion()` on the tracer resource) — one attribute cannot mean both the emitting service and the calling client, and reusing it would make every existing `service.version` query on cl-api ambiguous. Not an OTel attribute: the pinned package's `service.version` describes the emitter, and it publishes nothing for the version of a remote caller. Caller-attested, so it is telemetry only: nothing authenticates, authorizes, scopes a tenant, or routes on it. Bounded to a dotted release shape at the API trust boundary, so a path, an address, or prose cannot ride it, and an older Desktop that sends no header is attributed by omission.",
  },
  [TelemetryAttribute.AppErrorSource]: {
    producer: "apps/api/lib/route-utils.ts (cl-api request spans, ISS-7217)",
    sourceField: "errorSource",
    reason:
      "Closed enum naming WHICH LAYER produced a 5xx (route_handler, auth_wrapper, unattributed) — one axis, deliberately not conflated with what the failure was, which `error.type` carries. `unattributed` is a member rather than an omission so a 5xx nothing instrumented stays countable and visibly distinct from one that was attributed. No pinned OTel semantic convention owns the reporting layer, and `app.exception.origin` is the desktop process axis (pre_init/main/renderer), not this one.",
  },
  [TelemetryAttribute.ArtifactType]: {
    producer: "apps/api/app/documents (artifact routes, ISS-7224)",
    sourceField: "artifactType",
    reason:
      "The persisted artifact subtype (the canonical `DocumentType` value) read off the row the request actually touched, so the create/edit mix is sliceable by PRD vs FEATURE vs IMPLEMENTATION_PLAN vs TEMPLATE vs DOC — the path is `/documents/{id}` and carries no type. Emitted on the read, create, and update routes, which are the ones that already load the row; the DELETE route is deliberately NOT instrumented, because attributing it would cost an extra read on a write path for a slice the create-vs-edit question does not need. Low-cardinality SCREAMING_SNAKE token, structurally incapable of carrying a path, an address, or prose; no pinned OTel semantic convention owns application artifact identity.",
  },
  [TelemetryAttribute.ArtifactStatus]: {
    producer: "apps/api/app/documents (artifact routes, ISS-7224)",
    sourceField: "artifactStatus",
    reason:
      "The persisted artifact status, from whichever closed vocabulary the subtype uses (`DocumentStatus` for documents, `IssueStatus` for the FEATURE subtype). It is what separates an artifact type in real use from one created once and abandoned. Same low-cardinality SCREAMING_SNAKE token shape as `artifact.type`; no pinned OTel semantic convention owns it.",
  },
  [TelemetryAttribute.AppExceptionOrigin]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1986)",
    sourceField: "exceptionOrigin",
    reason:
      "Desktop classifies exception telemetry origin as a ClosedLoop compatibility field until an OTel semantic convention owns this app-process projection.",
  },
  [TelemetryAttribute.AppBootFailureKind]: {
    producer:
      "apps/desktop/src/main/lifecycle/migration-refusal.ts (Agent Monitor boot-failure classification, ISS-8907)",
    sourceField: "bootFailureKind",
    reason:
      "Closed four-member classification of WHY the Agent Monitor runtime failed to boot, on the one record that survives that failure. Deliberately a second axis rather than a reuse of `exception.type`, which names the thrown class and is `Error` for every non-refusal boot failure, or of `app.exception.origin`, which is the emitting process (pre_init/main/renderer) and says nothing about cause. Every member is a fixed literal, and each is chosen by a check that reads no free text into it — `migration_refusal` from the thrown class, `module_resolution` from the error's Node `code`, ISS-9197's `store_open_timeout` from one fixed token the deadline timer itself mints, and `unknown` from no predicate at all, as the fallback — so no branch can copy a substring of the error INTO the value, and the attribute stays structurally incapable of carrying a path, a module specifier, or a checksum, which is what ISS-4714 removed from this record and this attribute must not reintroduce. No pinned OTel semantic convention owns an application boot-failure cause.",
  },
  [TelemetryAttribute.AppBootFailureOutcome]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-runtime-bootstrap.ts (Agent Monitor boot-failure outcome, ISS-9259)",
    sourceField: "bootFailureOutcome",
    reason:
      "Whether the boot failure named by `app.boot_failure.kind` ENDED the boot or cleared on a retry. A second axis rather than a widening of that kind, because ISS-9197's retry ladder reports a recovery under the SAME kind on purpose — the monitor that counts the kind is the one that has to see the recovery — so the kind now describes a dead install and a healthy-but-slow one with one value, and every consumer keyed on it inherits that. Classified by the emit SITE and not by any property of the error: the exhaustion path knows it exhausted and the recovery path knows the open succeeded, so no branch reads free text into the value and the attribute stays structurally incapable of carrying a path or a specifier, exactly as `app.boot_failure.kind` does. Absent rather than defaulted on an older producer; no OTel semantic convention owns a boot-failure outcome.",
  },
  [TelemetryAttribute.AppOperatingMode]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1983)",
    sourceField: "operatingMode",
    reason:
      "Desktop emits the app operating mode as a ClosedLoop compatibility field until an OTel semantic convention owns this lifecycle projection.",
  },
  [TelemetryAttribute.AppLifecycleEvent]: {
    producer: "apps/desktop/src/main (desktop OTel SDK, FEA-1983)",
    sourceField: "lifecycleEvent",
    reason:
      "Desktop emits lifecycle event names as ClosedLoop compatibility fields until OTel defines an equivalent app lifecycle attribute.",
  },
  [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop OTel SDK, ISS-9082)",
    sourceField: "agentMonitorRuntimeStatus",
    reason:
      "Closed enum (ready/starting/failed) naming what the install's own Agent Monitor capture runtime reports about ITSELF, on the lifecycle heartbeat. Every other capture signal desktop emits — sync spans, sync batch counts, import health — is a work OUTCOME, and an install with no agent sessions produces exactly what an install whose capture never came up produces, so no threshold over any of them can tell a dead capture from an idle user (ISS-8906 ran a day dark that way). Carried on the existing heartbeat rather than a new emitter because the heartbeat already proves the PROCESS is alive and this is the missing half of the same sentence; no new timer, no new record, no added volume. Only `kind` — the sibling `reason` in the IPC status is user-facing prose and stays off the wire. No pinned OTel semantic convention owns an application subsystem's self-reported health.",
  },
  [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "droppedOversize",
    reason:
      "Exports the keyless relay transport dropped for a body larger than the session's negotiated limit, or the pre-session default. Cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat, so a later heartbeat still carries a drop whose own interval's heartbeat was the export that was dropped. Counts EXPORT ATTEMPTS (one serialized OTLP batch of one signal each), not records; a batch replayed from the warm-up queue after a no-session drop can be counted again under another cause or as sent, so the five counts do not sum to distinct lost batches. Omitted on a build with no relay transport (an unpackaged or egress-disabled launch) rather than zeroed. The pinned OTel `1.39.0` semantic conventions name only METRIC instruments for exporter self-observability (`otel.sdk.exporter.{span,log,metric_data_point}.exported`), which count items per signal, so no OTel attribute owns a per-cause export-call count on an app log record.",
  },
  [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "droppedNoSession",
    reason:
      "Exports the keyless relay transport dropped for no live relay session at send time: socket down, handshake refused, or a re-handshake after `invalid_session` that failed. A socket-down or handshake-refused drop is also parked in the transport's bounded warm-up queue (8 entries, oldest evicted) and is replayed if a session comes up before it is evicted; a failed re-handshake is not parked. So this is an UPPER bound on no-session loss, not an exact count. Cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat, so a later heartbeat still carries a drop whose own interval's heartbeat was the export that was dropped. Counts EXPORT ATTEMPTS (one serialized OTLP batch of one signal each), not records; a batch replayed from the warm-up queue after a no-session drop can be counted again under another cause or as sent, so the five counts do not sum to distinct lost batches. Omitted on a build with no relay transport (an unpackaged or egress-disabled launch) rather than zeroed. The pinned OTel `1.39.0` semantic conventions name only METRIC instruments for exporter self-observability (`otel.sdk.exporter.{span,log,metric_data_point}.exported`), which count items per signal, so no OTel attribute owns a per-cause export-call count on an app log record.",
  },
  [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "droppedRateLimited",
    reason:
      "Exports the keyless relay transport dropped for a relay `rate_limited` or `at_capacity` rejection, or an export refused locally during ANY relay cooldown, including one a `collector_unavailable`, `request_timeout` or missing ack set. Cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat, so a later heartbeat still carries a drop whose own interval's heartbeat was the export that was dropped. Counts EXPORT ATTEMPTS (one serialized OTLP batch of one signal each), not records; a batch replayed from the warm-up queue after a no-session drop can be counted again under another cause or as sent, so the five counts do not sum to distinct lost batches. Omitted on a build with no relay transport (an unpackaged or egress-disabled launch) rather than zeroed. The pinned OTel `1.39.0` semantic conventions name only METRIC instruments for exporter self-observability (`otel.sdk.exporter.{span,log,metric_data_point}.exported`), which count items per signal, so no OTel attribute owns a per-cause export-call count on an app log record.",
  },
  [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "droppedCollectorUnavailable",
    reason:
      "Exports the keyless relay transport dropped for a relay `collector_unavailable` or `request_timeout` rejection, or no ack before the transport's ack timeout. Cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat, so a later heartbeat still carries a drop whose own interval's heartbeat was the export that was dropped. Counts EXPORT ATTEMPTS (one serialized OTLP batch of one signal each), not records; a batch replayed from the warm-up queue after a no-session drop can be counted again under another cause or as sent, so the five counts do not sum to distinct lost batches. Omitted on a build with no relay transport (an unpackaged or egress-disabled launch) rather than zeroed. The pinned OTel `1.39.0` semantic conventions name only METRIC instruments for exporter self-observability (`otel.sdk.exporter.{span,log,metric_data_point}.exported`), which count items per signal, so no OTel attribute owns a per-cause export-call count on an app log record.",
  },
  [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "droppedInvalid",
    reason:
      "Exports the keyless relay transport dropped for any other relay rejection (`payload_too_large`, `unsupported_signal`, `invalid_content_type`, `invalid_request`, `otlp_rejected`). Cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat, so a later heartbeat still carries a drop whose own interval's heartbeat was the export that was dropped. Counts EXPORT ATTEMPTS (one serialized OTLP batch of one signal each), not records; a batch replayed from the warm-up queue after a no-session drop can be counted again under another cause or as sent, so the five counts do not sum to distinct lost batches. Omitted on a build with no relay transport (an unpackaged or egress-disabled launch) rather than zeroed. The pinned OTel `1.39.0` semantic conventions name only METRIC instruments for exporter self-observability (`otel.sdk.exporter.{span,log,metric_data_point}.exported`), which count items per signal, so no OTel attribute owns a per-cause export-call count on an app log record.",
  },
  [TelemetryAttribute.AppTelemetryExportSentCount]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-lifecycle.ts (desktop lifecycle heartbeat, ISS-11866 R4)",
    sourceField: "sent",
    reason:
      'Exports the relay acknowledged as accepted, cumulative since the desktop process started, read off `RelayTelemetryTransport.getDiagnostics()` at each lifecycle heartbeat beside the five `app.telemetry_export.dropped_*_count` attributes (Perrin Upcott, 2026-10-07: "export sent too"). Each accepted batch is counted here exactly once, including one replayed from the warm-up queue after an earlier no-session drop, so with D the five drops summed, D / (sent + D) is the loss rate when `dropped_no_session_count` is 0 and an upper bound otherwise, and the four non-session drops over (sent + D) is a lower bound. A batch whose ack timed out counts as `dropped_collector_unavailable_count` even if the relay forwarded it late. Omitted on a build with no relay transport rather than zeroed. The pinned OTel `1.39.0` semantic conventions name exporter self-observability only as METRIC instruments (`otel.sdk.exporter.*.exported`), so no OTel attribute owns this count on an app log record.',
  },
  [TelemetryAttribute.DurationMs]: {
    producer:
      "apps/api/lib/route-utils.ts (cl-api request_completed logs), apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (Agent Dashboard IPC perf wide events, FEA-1997), and the PRD-648 routine executor (routine execution and step elapsed time, contract-first, ISS-6313)",
    sourceField: "duration_ms",
    reason:
      "Elapsed milliseconds, shared by every group that needs one rather than respelled per group — ISS-6313 put the routine/audit group on THIS key instead of a `routine.*` twin for exactly that reason, which is what made it a multi-producer attribute. Naming every lane is load-bearing rather than housekeeping: this inventory is where a producer looks to find out whether an attribute already has an owner, and an entry naming one lane reads as though the key belongs to that lane and the next producer needs a name of its own. That is the SSOT drift this package keeps paying for. Still a ClosedLoop compatibility field until downstream native span timing work adopts a canonical duration representation. READ THIS BEFORE BUILDING AN ALARM ON THE DESKTOP IPC LANE: since ISS-9254 NO collector keep policy reads this attribute. `keep-slow` was a `numeric_attribute` over `duration_ms` and is now a whole-trace `latency` policy, so a slow IPC call trips nothing of its own — the wide event is a child of the desktop activity-window root and `tail_sampling` decides per TRACE, not per span. It is therefore retained at `CollectorTailSamplingPolicy.baselineSamplingPercentage`, OR when any span in the same activity window errored, OR when that window itself ran past the keep-slow threshold. Inclusion is correlated with the health of the window AND with how long it lasted, and a long window is the very condition the FEA-1997 many-sessions cliff consists of — so the sample is thinnest on the fast installs and richest on exactly the slow ones the metric exists to find. No fleet aggregate over the retained population is unbiased: not a mean, not a percentile, not a trend, not a threshold alarm. One retained value is still a call that genuinely took that long; it is the population, not the observation, that is not real. The desktop head-sampler emits every call at or above its own 2,000ms slow threshold, but a 100% head-sample is NOT 100% arrival — the collector decides afterwards and knows nothing about that threshold. This paragraph covers the desktop IPC lane only: the cl-api producer writes LOGS and `tail_sampling` is trace-only, so it is unaffected, and the PRD-648 routine/audit lane is contract-first with no producer shipping yet. `src/sync-sampling-bias.ts` carries the same statement for the sync group.",
  },
  [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: {
    producer:
      "apps/desktop/src/main/telemetry/gen-ai-request-telemetry.ts (one span per completed LLM request from live transcript imports, ISS-11347)",
    sourceField: "cacheCreationInputTokens",
    reason:
      "Cache-token fields are ClosedLoop compatibility attributes unless the pinned OTel JS package exports them.",
  },
  [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: {
    producer:
      "apps/desktop/src/main/telemetry/gen-ai-request-telemetry.ts (one span per completed LLM request from live transcript imports, ISS-11347)",
    sourceField: "cacheReadInputTokens",
    reason:
      "Cache-token fields are ClosedLoop compatibility attributes unless the pinned OTel JS package exports them.",
  },
  [TelemetryAttribute.SyncEvent]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "syncEvent",
    reason:
      "Sync event names are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncOutcome]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "outcome",
    reason:
      "Sync outcome values are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent. A RATE derived from this SPAN attribute is biased and not merely noisy: a failure sets span status ERROR and is retained whole while a success is tail-sampled, so `failure / (success + failure)` reads catastrophically worse than the fleet is. ISS-7497 therefore also emits the same outcome on the `sync.batch.count` metric (`SyncBatchCounterName`), which `tail_sampling` does not touch — every rate belongs to that counter, and this attribute stays the per-batch forensic record. Retention per attribute: `src/sync-sampling-bias.ts`.",
  },
  [TelemetryAttribute.SyncPayloadBytes]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "payloadBytes",
    reason:
      "Sync payload byte counts are ClosedLoop transport-health concepts with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncLatencyMs]: {
    producer:
      "apps/desktop/src/main/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-1995)",
    sourceField: "latencyMs",
    reason:
      "Sync latency as an attribute is a ClosedLoop transport-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncReason]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, FEA-3426)",
    sourceField: "reason",
    reason:
      "Sync failure/dead-letter reason (closed enum: ack_timeout, rate_limited, ingestion_failed, validation_failed, feature_disabled, locally_oversized, transport_error, unhydratable) is a ClosedLoop transport-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncLane]: {
    producer:
      "apps/desktop/src/main/agent-sync/sync-lane-cloud-health.ts (all five desktop→cloud sync lanes, ISS-6338)",
    sourceField: "lane",
    reason:
      "Which of the five ClosedLoop desktop→cloud sync state machines produced the batch (closed enum) has no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.SyncDeadLetteredCount]: {
    producer:
      "apps/desktop/src/main/agent-sync/sync-lane-cloud-health.ts (all five desktop→cloud sync lanes, ISS-6338)",
    sourceField: "deadLetteredCount",
    reason:
      "Items a sync lane has abandoned is a ClosedLoop transport-health count with no pinned OTel semantic convention equivalent. Attached only on the dead-letter arm, whose span is ERROR and is therefore retained whole by the collector rather than tail-sampled — which makes DLQ depth the one sync measure ISS-7497 certifies as unbiased (`src/sync-sampling-bias.ts`). A dead-letter RATE is not: the attempt denominator is sampled.",
  },
  [TelemetryAttribute.SyncBatchId]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, ISS-7248) and apps/api/lib/desktop-agent-sessions-handler.ts (cl-api request spans, ISS-7227)",
    sourceField: "batchId",
    reason:
      "The client-generated batch id already carried in the sync request body (`AgentSessionSyncBatch.batchId`) is the only value both halves of a sync attempt can name, so it is the client/server join key; OTel's trace identity lives in the span envelope, not in an attribute, and no pinned semantic convention owns an application-level batch identifier. ISS-7227 gave the cl-api ingest emitter the SAME attribute name rather than a second spelling, for the reason ISS-7221 did with `app.organization.id`: a per-side name leaves the join unmakeable, which was the whole defect. The server reads it under the same UUID constraint the ingest schema applies, before the rate limiter as well as after the parse, so every rejection the desktop records against a batch id — including `rate_limited`, which never reaches the parse — is joinable, while a body carrying no readable id omits the attribute rather than a fabricated one.",
  },
  [TelemetryAttribute.SyncSessionCount]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, ISS-7248)",
    sourceField: "sessionCount",
    reason:
      "How many sessions rode the failed batch is a ClosedLoop transport-health count with no pinned OTel semantic convention equivalent; it is what makes bytes-per-session legible against `sync.payload_bytes`.",
  },
  [TelemetryAttribute.SyncAttempt]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, ISS-7248); apps/desktop/src/main/agent-sync/compute-target-ownership-heal.ts (ISS-11467)",
    sourceField: "attempt",
    reason:
      "Which consecutive attempt this failure is for the batch's hardest-hit row is a ClosedLoop transport-health count with no pinned OTel semantic convention equivalent; it is what separates a first failure from an exhausted retry budget. ISS-11467 added a SECOND producer with a narrower meaning, and the two are told apart by lane: on `sync.lane:invocation_parts` the value is never a retry-budget depth, because `target_not_owned` burns no budget and that lane emitted no attempt count at all before ISS-11467 — there it is the fixed literal 2, marking the one re-resolved ownership-heal send, and it appears on a SUCCESS as well as on a failure. So a monitor reading `sync.attempt > 1` as retry-budget consumption must exclude that lane; on every other lane the ISS-7248 meaning is unchanged.",
  },
  [TelemetryAttribute.SyncPayloadShaping]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, ISS-7248)",
    sourceField: "payloadShaping",
    reason:
      "How the sent payload was reshaped to fit the wire cap (closed enum: whole, chunked_head, chunked_tail, chunk_tail_discarded, tiling_stripped) is a ClosedLoop transport-health concept with no pinned OTel semantic convention equivalent. The slot holds one value: tiling_stripped (ISS-7265) outranks the chunk-POSITION values, so a stripped payload reports the strip here and its masked position only in the durable record's chunkPosition field; chunk_tail_discarded still outranks the strip. Emitted on a FAILED attempt with the full precedence above, and on a CONFIRMED delivery as tiling_stripped only — the delivery path knows the strip but not the chunk position, and it omits the attribute rather than reporting whole, because a delivery that shipped without its tiling is the one case that must never call itself complete.",
  },
  [TelemetryAttribute.SyncTilingStrippedCount]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-sync-service.ts (sync subsystem instrumentation, ISS-7265)",
    sourceField: "tilingStrippedSessionCount",
    reason:
      "How many sessions in the batch shipped without their activity-segment tiling is a ClosedLoop transport-health count with no pinned OTel semantic convention equivalent; `sync.payload_shaping` has one slot and cannot report a strip that co-occurs with an abandoned chunk sequence, so without this count that compound case reaches the span with no degradation signal at all. Emitted on BOTH outcomes and counted differently on each, because they answer different questions: on a failure it is the sent batch's strips (nothing landed, so the population is what departed), and on a delivery it is the strips among the ids the server CONFIRMED, gated on the final chunk. The delivery arm is the load-bearing one — success is the path that clears the durable outbox and dequeues the session, so it is where a stripped tiling becomes a permanent loss, and it emitted nothing at all until ISS-7265 closed it. Omitted, never zeroed, when nothing was stripped.",
  },
  [TelemetryAttribute.SyncFreshestSessionLagMs]: {
    producer:
      "apps/desktop/src/main/agent-sync/agent-session-freshness-lag.ts, emitted from the accepted-ack path (ISS-7496)",
    sourceField: "freshestSessionLagMs",
    reason:
      "Whole milliseconds between the newest `updatedAt` among the sessions the server CONFIRMED and the moment that confirmation was processed — the pipeline-freshness measure ISS-7220 named and could not build, because no freshness attribute existed. A duration, so no pinned OTel semantic convention owns it and it can carry no id, name, or path. Emitted only on a confirmed delivery, never on a failure or a non-final chunk, because a lag on a batch that delivered nothing reads as delivered freshness and is the false-completeness shape this contract exists to prevent; absent means unknown, not fresh. READ THIS BEFORE BUILDING AN ALARM ON IT: the collector tail-samples non-ERROR traces at `CollectorTailSamplingPolicy.baselineSamplingPercentage` unless the activity window ran long enough to trip `keep-slow`, so the retained population of these spans is a sample and a MINIMUM over a sample overstates the true minimum lag — a low-traffic install can go an alarm window with no retained sample while syncing normally. NO aggregate over this attribute is sound — not a threshold alarm, not a minimum, not a percentile, not a trend: a success is retained whenever any span in the same activity window errored or that window itself ran long enough to trip `keep-slow`, so inclusion is correlated with health and with window duration, and no statistic over that population is unbiased. One retained value is still a lag that genuinely occurred; it is the population, not the observation, that is not real. ISS-7497 moved the sync RATES onto the unsampled `sync.batch.count` metric and deliberately left this attribute span-side, because making it sound means choosing gauge-versus-histogram semantics and a fleet aggregation — that decides what the measure MEANS and was escalated rather than picked. `src/sync-sampling-bias.ts` carries the retention statement for every sync attribute.",
  },
  [TelemetryAttribute.GenAiCostUsage]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness cost events, PRD-468 FEA-1843) and apps/desktop/src/main/telemetry/gen-ai-request-telemetry.ts (the genai-prices estimate for one completed LLM request, ISS-11347)",
    sourceField: "costUsd",
    reason:
      "Per-call USD cost has no pinned OTel semantic convention; it remains a ClosedLoop compatibility field until OTel owns a GenAI cost attribute.",
  },
  [TelemetryAttribute.GenAiPermissionDecision]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness permission events, PRD-468 FEA-1843)",
    sourceField: "permissionDecision",
    reason:
      "Harness permission decisions have no pinned OTel semantic convention equivalent and stay ClosedLoop compatibility fields.",
  },
  [TelemetryAttribute.GenAiPermissionSource]: {
    producer:
      "apps/desktop in-process OTLP receiver (harness permission events, PRD-468 FEA-1843)",
    sourceField: "permissionSource",
    reason:
      "Harness permission sources (FR-020 closed set) have no pinned OTel semantic convention equivalent and stay ClosedLoop compatibility fields.",
  },
  [TelemetryAttribute.HarnessName]: {
    producer: "every harness emitter (PRD-468 multi-harness discriminator)",
    sourceField: "harnessName",
    reason:
      "Runtime-tool discriminator identifying the producing harness (claude/codex/cursor/copilot/opencode). Distinct from the CLOTS agent.name logical-actor attribute; no pinned OTel semantic convention owns it, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcOperation]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (Agent Dashboard IPC perf wide events, FEA-1997; dead_end.rate IPC call records, ISS-12039)",
    sourceField: "operation",
    reason:
      "Discriminator naming the instrumented Agent Dashboard IPC handler (list/detail/usage/page_data). No pinned OTel semantic convention owns Electron IPC handler identity, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcMatchedCount]: {
    producer:
      "apps/desktop/src/main/session/shared-agent-sessions-api.ts (Agent Dashboard list/page-data query observation, ISS-9586)",
    sourceField: "matchedCount",
    reason:
      "Rows matching the list query before pagination. No pinned OTel semantic convention owns this query-selectivity dimension, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcPayloadBytes]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (Agent Dashboard IPC perf wide events, FEA-1997)",
    sourceField: "payloadBytes",
    reason:
      "Serialized response byte size of an IPC perf wide event. No pinned OTel semantic convention owns IPC payload size, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcQueryExecution]: {
    producer:
      "apps/desktop/src/main/session/session-list-query-observability.ts (Agent Dashboard list/page-data query observation, ISS-9586)",
    sourceField: "execution",
    reason:
      "Closed execution-path discriminator for the list query. Unknown or newer values are omitted independently at the main-process boundary so version skew cannot discard the IPC span. No pinned OTel semantic convention owns this query-path dimension, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcQueryRefusal]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (canonical list-query refusal events, ISS-9586)",
    sourceField: "refusal",
    reason:
      "Closed, value-free refusal code for a canonical query the Desktop host rejected. It is separate from error.type, which remains the thrown class used by historical error facets. No pinned OTel semantic convention owns this product query-refusal classification, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcQuerySource]: {
    producer:
      "apps/desktop/src/main/session/session-list-query-observability.ts (Agent Dashboard list/page-data query observation, ISS-9586)",
    sourceField: "source",
    reason:
      "Closed discriminator separating canonical listQuery requests from legacy request parameters. It carries no query operands. No pinned OTel semantic convention owns this request-vocabulary dimension, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcResultCount]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (Agent Dashboard IPC perf wide events, FEA-1997)",
    sourceField: "resultCount",
    reason:
      "Row/record count returned by an IPC call. No pinned OTel semantic convention owns this query-shape dimension, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcScannedCount]: {
    producer:
      "apps/desktop/src/main/session/shared-agent-sessions-api.ts (hydrated fallback query observation, ISS-9586)",
    sourceField: "scannedCount",
    reason:
      "Rows actually inspected by an in-memory list fallback. SQL-only paths omit it because database rows scanned are not known. No pinned OTel semantic convention owns this query-cost dimension, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.IpcSessionCount]: {
    producer:
      "apps/desktop/src/main/dashboard/agent-dashboard-ipc-perf.ts (Agent Dashboard IPC perf wide events, FEA-1997)",
    sourceField: "sessionCount",
    reason:
      "Total local-store session count — the fleet dimension that exposes the many-sessions perf cliff. No pinned OTel semantic convention owns it, so it stays a ClosedLoop compatibility field.",
  },
  [TelemetryAttribute.ImportEvent]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-5103)",
    sourceField: "kind",
    reason:
      "Discriminator for desktop local-store import-health events (group_failed vs pass summary). ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportOutcome]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-6335)",
    sourceField: "outcome",
    reason:
      "Closed set naming what one steady-state import window did (imported / empty / wedged / error), so a healthy install with nothing to import stays distinguishable from an install whose imports never land and from a process that stopped reporting. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportGroupLabel]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-5103)",
    sourceField: "groupLabel",
    reason:
      "Closed low-cardinality set naming the sqlite import record group that failed (the write-core runGroup labels, plus `unknown` as the version-skew fallback). ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportGroupFailedCount]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-5103)",
    sourceField: "count",
    reason:
      "Count of tolerated import-group failures for one group label in the tally window. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportSessionsIncomplete]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-5103)",
    sourceField: "sessionsIncomplete",
    reason:
      "Count of importSession results flagged `incomplete` in the tally window. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportSessionsPendingRevision]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-5103)",
    sourceField: "sessionsPendingRevision",
    reason:
      "Count of sessions stuck at the DATA_REVISION_IMPORT_PENDING sentinel from before the tally window began. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportSourcesRemaining]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (desktop import-health counters, ISS-6116)",
    sourceField: "sourcesRemaining",
    reason:
      "Source files one harness's first-pass backfill has still not finished, reported every settled window so a flat-lining series names a wedged backfill without a threshold guess. The sentinel counts cannot see this failure: a source whose import never lands writes no session row, so nothing reaches the sentinel to be counted. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportIngestFailure]: {
    producer:
      "apps/desktop/src/main/collectors (collector ingest-failure counters, ISS-6336)",
    sourceField: "reason",
    reason:
      "Closed low-cardinality set naming how one collector ingest failure presented (a source whose parse threw or timed out, a session the parser could only read partially or could not route). Closed with no `unknown` member: every value is produced by this repo's own collectors, so a reason it does not carry is a contract the producer does not have yet, not a version-skew fallback. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportIngestFailedCount]: {
    producer:
      "apps/desktop/src/main/collectors (collector ingest-failure counters, ISS-6336)",
    sourceField: "count",
    reason:
      "Count of collector ingest failures carrying one reason in the tally window. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportParseDegradedSite]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (parse-degradation fold-site attribution, ISS-12036)",
    sourceField: "degradedSite",
    reason:
      "Closed low-cardinality set naming WHICH of a session's three folded transcript files lost the corrupt lines a `session_parse_degraded` / `session_parse_unreadable` reason counts: the session's own transcript, a folded child (a Claude subagent sidecar or a Codex workflow journal), a folded descendant rollout (a Codex fork/resume child), or `multiple` when more than one did. All three fold into one malformed-line total, so the reason alone could not tell a corrupting harness writer from a corrupting fold. Omitted rather than defaulted when the session's parse quality carries no per-site counts. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportSourcesQuarantinedParse]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (collector quarantine gauge, ISS-6336)",
    sourceField: "quarantinedByStage.parse",
    reason:
      "GAUGE — transcripts currently quarantined at the PARSE stage, meaning the file could not be read. Carried on every pass record including at zero, so a reader can answer 'is this install's ingest broken right now' rather than integrating a cadence-dependent occurrence count. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.ImportSourcesQuarantinedImport]: {
    producer:
      "apps/desktop/src/main/telemetry/import-health-telemetry.ts (collector quarantine gauge, ISS-6336)",
    sourceField: "quarantinedByStage.import",
    reason:
      "GAUGE — transcripts currently quarantined at the IMPORT stage, meaning the file was read and its write did not finish. Split from the parse stage because the two need different remediation. Carried on every pass record including at zero. ClosedLoop store-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.AuthOutcome]: {
    producer:
      "apps/desktop/src/main/cloud/auth-failure-telemetry.ts (desktop auth/pairing failure signal, ISS-6334)",
    sourceField: "outcome",
    reason:
      "Which authentication stage failed (pairing handshake, browser redirect or exchange, session refresh, or a rejected access token). ClosedLoop onboarding-health concept with no pinned OTel semantic convention equivalent; a closed enum, never free text.",
  },
  [TelemetryAttribute.AuthReason]: {
    producer:
      "apps/desktop/src/main/cloud/auth-failure-telemetry.ts (desktop auth/pairing failure signal, ISS-6334)",
    sourceField: "reason",
    reason:
      "Closed-enum cause for the failed authentication stage, mapped from the cloud nack reason or the session-endpoint error. Unrecognized inputs collapse to `unknown`, so no credential, path, identifier, or server-supplied string can reach this attribute.",
  },
  [TelemetryAttribute.OnboardingStep]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-onboarding.ts (desktop onboarding lifecycle events, ISS-6340)",
    sourceField: "step",
    reason:
      "Closed three-value set naming which step of the desktop onboarding flow an event describes. Product-onboarding concept with no pinned OTel semantic convention equivalent; carries no identity, free text, or path.",
  },
  [TelemetryAttribute.OnboardingEvent]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-onboarding.ts (desktop onboarding lifecycle events, ISS-6340)",
    sourceField: "event",
    reason:
      "Discriminator for desktop onboarding lifecycle records (step reached, step failed, flow abandoned, consent recorded). ClosedLoop product-onboarding concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.OnboardingConsentLevel]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-onboarding.ts (desktop onboarding lifecycle events, ISS-6340)",
    sourceField: "consentLevel",
    reason:
      "The data-sync level the user picked at the onboarding consent step, as a closed enum (`off` is the decline). A product-configuration choice, not user data: no identity, org, content, or path travels with it. Present only on `consent_recorded` records.",
  },
  [TelemetryAttribute.OnboardingAnalyticsAction]: {
    producer:
      "apps/desktop/src/main/telemetry/onboarding-discard-telemetry.ts (onboarding analytics discard diagnostics, ISS-12421)",
    sourceField: "action",
    reason:
      "Discriminator for an onboarding analytics discard diagnostic (`event_dropped`), the operational record the ISS-12420 readiness queue writes when it refuses to deliver a buffered PostHog event. Closed enum; no identity travels with it.",
  },
  [TelemetryAttribute.OnboardingAnalyticsReason]: {
    producer:
      "apps/desktop/src/main/telemetry/onboarding-discard-telemetry.ts (onboarding analytics discard diagnostics, ISS-12421)",
    sourceField: "reason",
    reason:
      "Why the queued onboarding analytics event was discarded (signed out, identity changed, organization mismatch, expired, overflow), as a closed enum. A discard cause, not user data.",
  },
  [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]: {
    producer:
      "apps/desktop/src/main/telemetry/onboarding-discard-telemetry.ts (onboarding analytics discard diagnostics, ISS-12421)",
    sourceField: "original_event",
    reason:
      "The name of the discarded onboarding analytics event, as a closed enum mirroring the PRD-736 onboarding event catalog. The event's properties are never attached.",
  },
  [TelemetryAttribute.OnboardingAnalyticsStep]: {
    producer:
      "apps/desktop/src/main/telemetry/onboarding-discard-telemetry.ts (onboarding analytics discard diagnostics, ISS-12421)",
    sourceField: "step",
    reason:
      "The onboarding phase the discarded event described, as a closed enum mirroring the canonical onboarding phases. Omitted when the event carried no recognized phase.",
  },
  [TelemetryAttribute.OnboardingAnalyticsFlowId]: {
    producer:
      "apps/desktop/src/main/telemetry/onboarding-discard-telemetry.ts (onboarding analytics discard diagnostics, ISS-12421)",
    sourceField: "flow_id",
    reason:
      "The discarded event's onboarding attempt id, a random v4 UUID minted per onboarding attempt (PRD-793 approves it on these records). Not an account, node, or device id. Omitted when the event carried no well-formed attempt id.",
  },
  [TelemetryAttribute.UpdateEvent]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7247)",
    sourceField: "event",
    reason:
      "Discriminator naming which transition of the desktop update lifecycle a record describes (check → available → download → install → restart → post-restart terminal). ClosedLoop release-health concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.UpdateFromVersion]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7247)",
    sourceField: "fromVersion",
    reason:
      "The version the installation is running when the attempt starts. Distinct from `service.version` because the terminal record is emitted from the OTHER side of the restart, where `service.version` is already the NEW build and the origin version would otherwise be unrecoverable.",
  },
  [TelemetryAttribute.UpdateToVersion]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7247)",
    sourceField: "toVersion",
    reason:
      "The version the attempt is upgrading to — the offered release on a check, the expected version on a restart. Pairing it with `update.from_version` is what makes upgrade success rate answerable per from→to release pair, and the check record's pair is the upgrade-lag measure ISS-7225 asks for.",
  },
  [TelemetryAttribute.UpdateFailureReason]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7247)",
    sourceField: "failureReason",
    reason:
      "Closed enum naming why an update attempt failed (download_error, signature, permission, disk, crash_on_boot, version_unchanged, unexpected_version, unknown). Present on the four `update.event` values that carry it — `check_failed`, `download_failed`, `install_blocked`, and `restart_failed` — so a failure population narrowed to the download and restart events alone drops every unreachable-feed and unstageable-install failure. `permission` is overloaded across three of those four events and `update.event` is the only discriminator between its two meanings: permanent on `install_blocked` (read-only/translocated mount, nothing retried until a human moves the app), and a transient EACCES/EPERM read from the updater's message by one shared classifier on BOTH `check_failed` and `download_failed` — so a transient-permission population narrowed to `download_failed` alone drops its entire check-path half. Carries no error text — the raw message stays on the auth-gated diagnostics lane. Present only on failure records.",
  },
  [TelemetryAttribute.UpdateBootAttempts]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7247)",
    sourceField: "bootAttempts",
    reason:
      "How many boots the pending attempt has survived to its reconciliation point. `1` is a clean restart; anything higher means an earlier boot died before it could report, which is what separates a boot-crash from a clean upgrade. Present only on post-restart terminal records.",
  },
  [TelemetryAttribute.UpdateCurrentVersionAgeDays]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-update.ts (desktop update lifecycle events, ISS-7225)",
    sourceField: "currentVersionAgeDays",
    reason:
      "Whole days since this installation first ran the version it is on now — the 'has not upgraded in N days' half of the upgrade-lag signal. A coarse local counter, not an install timestamp: it cannot date the machine or the user. Present only on check records.",
  },
  [TelemetryAttribute.DeadEndTreatment]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "treatment",
    reason:
      "Which user-facing 'we could not show you what you asked for' treatment rendered, as a closed enum naming the surface and the treatment. No OTel semantic convention describes a rendered UI failure state.",
  },
  [TelemetryAttribute.DeadEndPhase]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249; dead_end.rate records, ISS-12039)",
    sourceField: "phase",
    reason:
      "Whether the record is the treatment rendering, a retry the user took, or that retry settling. Separating them is what makes 'a retry affordance that never succeeds' answerable rather than inferred.",
  },
  [TelemetryAttribute.DeadEndState]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "state",
    reason:
      "Which of the five distinct no-data states the surface is in (loading, unavailable, not_applicable, unknown, true_zero). Collapsing them is the defect ISS-7249 exists to fix, so the axis is carried explicitly rather than derived downstream.",
  },
  [TelemetryAttribute.DeadEndReason]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "reason",
    reason:
      "Why the surface reached that state, as a closed enum (not_yet_synced, absent, fetch_failed, permission_denied, loading_threshold_exceeded, filtered_out, unclassified). The state says what the user sees; this says what we actually established.",
  },
  [TelemetryAttribute.DeadEndRetryOffered]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "retryOffered",
    reason:
      "Whether a retry affordance was on screen for this treatment. A dead end with no way out and one the user declined to take are different products, and the rate of the first is not readable without this.",
  },
  [TelemetryAttribute.DeadEndRetryAttempt]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "retryAttempt",
    reason:
      "How many retries the user has taken since this surface last worked, as a bounded count. A count, never a duration or an identifier.",
  },
  [TelemetryAttribute.DeadEndRetryOutcome]: {
    producer:
      "apps/desktop/src/main/telemetry/app-otel-runtime-dead-end.ts (desktop dead-end treatment events, ISS-7249)",
    sourceField: "retryOutcome",
    reason:
      "Whether the read a retry kicked off cleared the dead end or landed on another one. Present only on `retry_settled` records, so the attribute's presence is itself the statement that a retry finished.",
  },
  [TelemetryAttribute.RoutineId]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "routineId",
    reason:
      "The customer's own identifier for the automation definition an execution belongs to — the slice key that makes per-routine success rate answerable in the customer's Datadog rather than only in our dashboard. Constrained to the UUID SHAPE for the same reason `sync.batch_id` is: a value that must match that pattern cannot smuggle a routine name, a repository path, or prose onto the keyless lane. A producer whose ids are not UUIDs must widen the pattern in a deliberate contract change rather than at the call site. No pinned OTel semantic convention owns an application automation identity.",
  },
  [TelemetryAttribute.RoutineEvent]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "event",
    reason:
      "Discriminator naming which record of one routine execution's lifecycle this is (scheduled, started, step_settled, settled). Separating the schedule from the start is what makes a routine that never gets picked up distinguishable from one that runs and fails; a single terminal counter would collapse them. ClosedLoop automation concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.RoutineTrigger]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "trigger",
    reason:
      "Closed enum naming what started the execution (schedule, manual, webhook, api, unknown). `unknown` is a member rather than an omission so a version-skewed producer emitting a trigger this contract has not learned yet degrades to a recorded safe default and stays countable, instead of dropping the attribute and inflating the other buckets. No pinned OTel semantic convention owns automation invocation source.",
  },
  [TelemetryAttribute.RoutineOutcome]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "outcome",
    reason:
      "Closed enum naming how the execution ended (success, failed, skipped, timeout, canceled, unknown) — the lowercase projection of the TERMINAL members of the platform's shipped `RoutineRunStatus`, not a second vocabulary for the same concept. `unknown` is the version-skew landing spot. The non-terminal statuses (pending, running) are deliberately absent: a run still in flight omits the attribute rather than reporting a running state as an outcome. No pinned OTel semantic convention owns automation run status.",
  },
  [TelemetryAttribute.RoutineFailureReason]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "failureReason",
    reason:
      "Closed enum naming why an execution did not succeed (step_error, permission_denied, timeout, dependency_unavailable, canceled_by_user, unknown). Carries no error text — the raw message stays on the auth-gated diagnostics lane, exactly as `update.failure_reason` does. Present only on non-success records, so its absence is itself the statement that nothing failed.",
  },
  [TelemetryAttribute.RoutineStepIndex]: {
    producer: "PRD-648 routine executor (contract-first, ISS-6313)",
    sourceField: "stepIndex",
    reason:
      "Zero-based position of the step a `step_settled` record describes, clamped to a ceiling so a wedged executor cannot grow the attribute's cardinality without bound. A position, never a step NAME: the name is customer-authored text and is deliberately not on this lane. It is what makes 'routines always die on the same step' answerable without reading anyone's automation definition.",
  },
  [TelemetryAttribute.AuditEvent]: {
    producer: "PRD-648 audit bot (contract-first, ISS-6313)",
    sourceField: "event",
    reason:
      "Discriminator naming which audit-trail record this is (entry_recorded, entry_exported, export_failed). `export_failed` is carried explicitly because an audit trail that silently stops exporting is indistinguishable from one with nothing to export unless the failure has its own record. ClosedLoop governance concept with no pinned OTel semantic convention equivalent.",
  },
  [TelemetryAttribute.AuditActorKind]: {
    producer: "PRD-648 audit bot (contract-first, ISS-6313)",
    sourceField: "actorKind",
    reason:
      "Closed enum naming WHAT KIND of actor an audited action came from (user, agent, system, unknown) — the human-in-the-loop ratio this platform is governed on. The first three are the exact tokens the audit ledger persists as `AuditActorType`, which are hashed into its chain and add-never-rename, so a telemetry respelling would make a record and the entry it describes unjoinable. Deliberately a kind and never an identity: no user id, email, or display name has a home in this group, so the human/agent mix is measurable without the keyless lane ever learning who acted.",
  },
  [TelemetryAttribute.AuditDecision]: {
    producer: "PRD-648 audit bot (contract-first, ISS-6313)",
    sourceField: "decision",
    reason:
      "Closed enum naming how a review gate resolved (approved, rejected, auto_approved, escalated, expired, unknown). `auto_approved` is separate from `approved` because collapsing them would report an ungoverned auto-approval as human oversight, and `expired` is separate from `rejected` because nobody decided it. `unknown` is the version-skew landing spot: the app schema is strict, so a decision this contract has not learned yet would fail the parse and drop the whole audit record rather than the one attribute, and a governance record that silently vanishes is the worst failure available to this group. No pinned OTel semantic convention owns a governance decision.",
  },
} as const satisfies Record<
  ClosedLoopCompatibilityAttribute,
  { producer: string; sourceField: string; reason: string }
>;
