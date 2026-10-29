/** Published telemetry attribute names shared by schemas and callers. */
export const TelemetryAttribute = {
  ServiceName: "service.name",
  ServiceVersion: "service.version",
  AppInstallationId: "app.installation.id",
  AppClientVersion: "app.client.version",
  DeviceId: "device.id",
  AppOrganizationId: "app.organization.id",
  UserId: "user.id",
  DeploymentEnvironmentName: "deployment.environment.name",
  ExceptionType: "exception.type",
  ExceptionMessage: "exception.message",
  ExceptionStacktrace: "exception.stacktrace",
  AppExceptionOrigin: "app.exception.origin",
  AppBootFailureKind: "app.boot_failure.kind",
  AppBootFailureOutcome: "app.boot_failure.outcome",
  AppOperatingMode: "app.operating_mode",
  AppLifecycleEvent: "app.lifecycle.event",
  AppAgentMonitorRuntimeStatus: "app.agent_monitor.runtime_status",
  AppTelemetryExportDroppedOversizeCount:
    "app.telemetry_export.dropped_oversize_count",
  AppTelemetryExportDroppedNoSessionCount:
    "app.telemetry_export.dropped_no_session_count",
  AppTelemetryExportDroppedRateLimitedCount:
    "app.telemetry_export.dropped_rate_limited_count",
  AppTelemetryExportDroppedCollectorUnavailableCount:
    "app.telemetry_export.dropped_collector_unavailable_count",
  AppTelemetryExportDroppedInvalidCount:
    "app.telemetry_export.dropped_invalid_count",
  AppTelemetryExportSentCount: "app.telemetry_export.sent_count",
  HttpRequestMethod: "http.request.method",
  HttpResponseStatusCode: "http.response.status_code",
  UrlPath: "url.path",
  DurationMs: "duration_ms",
  CodeFunctionName: "code.function.name",
  CodeFilePath: "code.file.path",
  CodeLineNumber: "code.line.number",
  CodeColumnNumber: "code.column.number",
  ErrorType: "error.type",
  AppErrorSource: "app.error.source",
  ArtifactType: "artifact.type",
  ArtifactStatus: "artifact.status",
  GenAiUsageInputTokens: "gen_ai.usage.input_tokens",
  GenAiUsageOutputTokens: "gen_ai.usage.output_tokens",
  GenAiRequestModel: "gen_ai.request.model",
  GenAiResponseId: "gen_ai.response.id",
  GenAiUsageCacheCreationInputTokens:
    "gen_ai.usage.cache_creation.input_tokens",
  GenAiUsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  GenAiOperationName: "gen_ai.operation.name",
  SyncEvent: "sync.event",
  SyncOutcome: "sync.outcome",
  SyncPayloadBytes: "sync.payload_bytes",
  SyncLatencyMs: "sync.latency_ms",
  SyncReason: "sync.reason",
  SyncLane: "sync.lane",
  SyncDeadLetteredCount: "sync.dead_lettered_count",
  SyncBatchId: "sync.batch_id",
  SyncSessionCount: "sync.session_count",
  SyncAttempt: "sync.attempt",
  SyncPayloadShaping: "sync.payload_shaping",
  SyncTilingStrippedCount: "sync.tiling_stripped_count",
  SyncFreshestSessionLagMs: "sync.freshest_session_lag_ms",
  GenAiCostUsage: "gen_ai.cost.usage",
  GenAiPermissionDecision: "gen_ai.permission.decision",
  GenAiPermissionSource: "gen_ai.permission.source",
  HarnessName: "harness.name",
  IpcOperation: "ipc.operation",
  IpcMatchedCount: "ipc.matched_count",
  IpcPayloadBytes: "ipc.payload_bytes",
  IpcQueryExecution: "ipc.query_execution",
  IpcQueryRefusal: "ipc.query_refusal",
  IpcQuerySource: "ipc.query_source",
  IpcResultCount: "ipc.result_count",
  IpcScannedCount: "ipc.scanned_count",
  IpcSessionCount: "ipc.session_count",
  ImportEvent: "import.event",
  ImportOutcome: "import.outcome",
  ImportGroupLabel: "import.group_label",
  ImportGroupFailedCount: "import.group_failed_count",
  ImportSessionsIncomplete: "import.sessions_incomplete",
  ImportSessionsPendingRevision: "import.sessions_pending_revision",
  ImportSourcesRemaining: "import.sources_remaining",
  ImportIngestFailure: "import.ingest_failure",
  ImportIngestFailedCount: "import.ingest_failed_count",
  ImportParseDegradedSite: "import.parse_degraded_site",
  ImportSourcesQuarantinedParse: "import.sources_quarantined_parse",
  ImportSourcesQuarantinedImport: "import.sources_quarantined_import",
  AuthOutcome: "auth.outcome",
  AuthReason: "auth.reason",
  OnboardingStep: "onboarding.step",
  OnboardingEvent: "onboarding.event",
  OnboardingConsentLevel: "onboarding.consent_level",
  OnboardingAnalyticsAction: "onboarding_analytics.action",
  OnboardingAnalyticsReason: "onboarding_analytics.reason",
  OnboardingAnalyticsOriginalEvent: "onboarding_analytics.original_event",
  OnboardingAnalyticsStep: "onboarding_analytics.step",
  OnboardingAnalyticsFlowId: "onboarding_analytics.flow_id",
  UpdateEvent: "update.event",
  UpdateFromVersion: "update.from_version",
  UpdateToVersion: "update.to_version",
  UpdateFailureReason: "update.failure_reason",
  UpdateBootAttempts: "update.boot_attempts",
  UpdateCurrentVersionAgeDays: "update.current_version_age_days",
  DeadEndTreatment: "dead_end.treatment",
  DeadEndPhase: "dead_end.phase",
  DeadEndState: "dead_end.state",
  DeadEndReason: "dead_end.reason",
  DeadEndRetryOffered: "dead_end.retry_offered",
  DeadEndRetryAttempt: "dead_end.retry_attempt",
  DeadEndRetryOutcome: "dead_end.retry_outcome",
  RoutineId: "routine.id",
  RoutineEvent: "routine.event",
  RoutineTrigger: "routine.trigger",
  RoutineOutcome: "routine.outcome",
  RoutineFailureReason: "routine.failure_reason",
  RoutineStepIndex: "routine.step_index",
  AuditEvent: "audit.event",
  AuditActorKind: "audit.actor_kind",
  AuditDecision: "audit.decision",
} as const;

/** Literal union of all published telemetry attribute names. */
export type TelemetryAttributeName =
  (typeof TelemetryAttribute)[keyof typeof TelemetryAttribute];

/**
 * Canonical, sorted, de-duplicated projection of every published telemetry
 * attribute name — the single source of truth the keyless-telemetry OTel
 * Collector's `redaction` allow-list is generated from (FEA-2170). Sorting is
 * lexicographic so the generated collector artifacts are deterministic and
 * diff-stable. The codegen, the drift guard, and FEA-2163's strict
 * per-attribute validation import this rather than re-deriving it, so there is
 * exactly one in-process projection.
 */
export const CollectorAllowedAttributeKeys: readonly TelemetryAttributeName[] =
  [...new Set(Object.values(TelemetryAttribute))].sort();

/**
 * Marker attribute keys whose presence on a span designates it a *product
 * signal* — a GenAI generation the keyless-telemetry OTel Collector fans out to
 * PostHog (PRD-481 C3 / FEA-1991) **in addition to** the Datadog ops leg.
 *
 * PostHog's OTLP ingestion is traces-only and AI-observability-shaped, so the
 * product-funnel signal we route there is the GenAI span, identified by its
 * required discriminator `gen_ai.request.model`. That marker only ROUTES the
 * span; PostHog names the event from `gen_ai.operation.name`: `chat` becomes
 * `$ai_generation` and a span without it `$ai_span`
 * (`rust/capture/src/otel/providers.rs` in PostHog/posthog), which ingestion
 * promotes to `$ai_trace` when it has no parent
 * (`nodejs/src/ingestion/pipelines/ai/otel/attribute-mapping.ts`, ISS-11347). This is the single source of truth the generated
 * `filter/product_signals` Collector fragment is derived from (FEA-1991): the
 * codegen and its drift guard import this rather than hard-coding the marker, so
 * a discriminator rename can never silently break PostHog routing. Sorted and
 * de-duplicated so the generated fragment is deterministic and diff-stable.
 */
export const CollectorProductSignalAttributeKeys: readonly TelemetryAttributeName[] =
  [
    ...new Set<TelemetryAttributeName>([TelemetryAttribute.GenAiRequestModel]),
  ].sort();

/** Ownership buckets for OTel-native and ClosedLoop compatibility attributes. */
export const TelemetryAttributeOwnership = {
  Otel: "otel",
  ClosedLoopCompatibility: "closedloop_compatibility",
} as const;

/** Literal union of telemetry attribute ownership buckets. */
export type TelemetryAttributeOwnership =
  (typeof TelemetryAttributeOwnership)[keyof typeof TelemetryAttributeOwnership];

/** Attributes allowed by the resource schema. */
export const ResourceTelemetryAttributes = [
  TelemetryAttribute.ServiceName,
  TelemetryAttribute.ServiceVersion,
  TelemetryAttribute.DeviceId,
  TelemetryAttribute.HarnessName,
] as const;

/**
 * ISS-6313 (PRD-648 D-17): routine-execution and audit-trail attributes.
 *
 * The differentiator over a vendor dashboard plus a CSV export is that these
 * ride the customer's OWN Datadog through the keyless collector, so the group is
 * a privacy boundary by construction: every member is a closed enum, a bounded
 * count, or an id constrained to a UUID shape. Nothing here can carry a routine
 * NAME, a prompt, a repository path, or an operator identity — a routine's
 * human-authored label is customer content and is deliberately absent rather
 * than bounded, because a length cap does not make prose non-sensitive.
 *
 * `duration_ms` is reused rather than given a `routine.*` twin: a second name
 * for an elapsed millisecond count is the SSOT drift this package keeps paying
 * for (precedent: `http.response.status_code` on the dead-end group, ISS-7249).
 */
export const RoutineAuditTelemetryAttributes = [
  TelemetryAttribute.RoutineId,
  TelemetryAttribute.RoutineEvent,
  TelemetryAttribute.RoutineTrigger,
  TelemetryAttribute.RoutineOutcome,
  TelemetryAttribute.RoutineFailureReason,
  TelemetryAttribute.RoutineStepIndex,
  TelemetryAttribute.DurationMs,
  TelemetryAttribute.AuditEvent,
  TelemetryAttribute.AuditActorKind,
  TelemetryAttribute.AuditDecision,
] as const;

/** App-level identity, deployment, lifecycle, and exception attributes. */
export const AppTelemetryAttributes = [
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.AppOrganizationId,
  TelemetryAttribute.DeploymentEnvironmentName,
  TelemetryAttribute.ExceptionType,
  TelemetryAttribute.ExceptionMessage,
  TelemetryAttribute.ExceptionStacktrace,
  TelemetryAttribute.AppExceptionOrigin,
  TelemetryAttribute.AppBootFailureKind,
  // ISS-9259: WHETHER that boot failure ended the boot or cleared on a retry.
  // The kind alone answers two opposite outcomes since ISS-9197's retry ladder
  // started reporting a recovery under the same kind.
  TelemetryAttribute.AppBootFailureOutcome,
  TelemetryAttribute.AppOperatingMode,
  TelemetryAttribute.AppLifecycleEvent,
  // ISS-9082: what the emitting install's own capture subsystem says about
  // itself, carried on the lifecycle heartbeat. Every other desktop capture
  // signal is a work OUTCOME, and absence of captured work cannot be told apart
  // from absence of work to capture — an idle install and a dead one produce
  // the same nothing. This is the one attribute that is not derived from work.
  TelemetryAttribute.AppAgentMonitorRuntimeStatus,
  // ISS-11866 (R4): the keyless relay transport's per-process drop and sent
  // counters, carried on the same heartbeat.
  TelemetryAttribute.AppTelemetryExportDroppedOversizeCount,
  TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount,
  TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount,
  TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount,
  TelemetryAttribute.AppTelemetryExportDroppedInvalidCount,
  TelemetryAttribute.AppTelemetryExportSentCount,
  TelemetryAttribute.ImportEvent,
  TelemetryAttribute.ImportOutcome,
  TelemetryAttribute.ImportGroupLabel,
  TelemetryAttribute.ImportGroupFailedCount,
  TelemetryAttribute.ImportSessionsIncomplete,
  TelemetryAttribute.ImportSessionsPendingRevision,
  // ISS-6116: the backfill-side import-health records are harness-scoped, so
  // the existing `harness.name` attribute (already a resource attribute, and
  // already on the collector allow-list) is reused here rather than minting a
  // second harness key.
  TelemetryAttribute.HarnessName,
  TelemetryAttribute.ImportSourcesRemaining,
  TelemetryAttribute.ImportIngestFailure,
  TelemetryAttribute.ImportIngestFailedCount,
  TelemetryAttribute.ImportParseDegradedSite,
  TelemetryAttribute.ImportSourcesQuarantinedParse,
  TelemetryAttribute.ImportSourcesQuarantinedImport,
  TelemetryAttribute.AuthOutcome,
  TelemetryAttribute.AuthReason,
  TelemetryAttribute.OnboardingStep,
  TelemetryAttribute.OnboardingEvent,
  TelemetryAttribute.OnboardingConsentLevel,
  TelemetryAttribute.OnboardingAnalyticsAction,
  TelemetryAttribute.OnboardingAnalyticsReason,
  TelemetryAttribute.OnboardingAnalyticsOriginalEvent,
  TelemetryAttribute.OnboardingAnalyticsStep,
  TelemetryAttribute.OnboardingAnalyticsFlowId,
  TelemetryAttribute.UpdateEvent,
  TelemetryAttribute.UpdateFromVersion,
  TelemetryAttribute.UpdateToVersion,
  TelemetryAttribute.UpdateFailureReason,
  TelemetryAttribute.UpdateBootAttempts,
  TelemetryAttribute.UpdateCurrentVersionAgeDays,
  TelemetryAttribute.DeadEndTreatment,
  TelemetryAttribute.DeadEndPhase,
  TelemetryAttribute.DeadEndState,
  TelemetryAttribute.DeadEndReason,
  TelemetryAttribute.DeadEndRetryOffered,
  TelemetryAttribute.DeadEndRetryAttempt,
  TelemetryAttribute.DeadEndRetryOutcome,
  // ISS-7249: the status a dead end's failed read came back with. The canonical
  // OTel key rather than a `dead_end.*` twin of it — a second name for an HTTP
  // status is the SSOT drift this repo keeps paying for.
  TelemetryAttribute.HttpResponseStatusCode,
  // ISS-6313: spread rather than listed, so this array stays the exhaustive
  // statement of what `AppTelemetrySchema` accepts while the routine/audit group
  // keeps a name of its own. Listing the members twice is how the two drift.
  ...RoutineAuditTelemetryAttributes,
] as const;

/** OTel HTTP span attributes allowed by the span schema. */
export const HttpSpanTelemetryAttributes = [
  TelemetryAttribute.HttpRequestMethod,
  TelemetryAttribute.HttpResponseStatusCode,
  TelemetryAttribute.UrlPath,
] as const;

/** ClosedLoop compatibility span attributes allowed until native adoption. */
export const CompatibilitySpanTelemetryAttributes = [
  TelemetryAttribute.DurationMs,
] as const;

/** Optional source-code span attributes allowed by the span schema. */
export const CodeSpanTelemetryAttributes = [
  TelemetryAttribute.CodeFunctionName,
  TelemetryAttribute.CodeFilePath,
  TelemetryAttribute.CodeLineNumber,
  TelemetryAttribute.CodeColumnNumber,
] as const;

/** Optional error span attributes allowed by the span schema. */
export const ErrorSpanTelemetryAttributes = [
  TelemetryAttribute.ErrorType,
] as const;

/**
 * Span attributes stamped by the `cl-api` request emitter
 * (ISS-7217/ISS-7221/ISS-7224/ISS-8748). Each is optional: a request that could
 * not honestly supply one omits it rather than inventing a value, so "absent"
 * stays readable as "not attributable" instead of collapsing into a default.
 *
 * Mixed ownership since ISS-8748, and the group is a per-SCHEMA inventory
 * rather than an owner ledger, so that is not a defect — `user.id` is OTel-owned
 * and the other four are ClosedLoop compatibility attributes.
 * `TelemetryAttributeOwnershipByName` is where ownership is stated; membership
 * here answers only "what can a cl-api request span carry".
 */
export const ApiSpanTelemetryAttributes = [
  TelemetryAttribute.AppOrganizationId,
  // ISS-8749: which Desktop install, and which Desktop build, made the call.
  // Both are CALLER-ATTESTED — read off request headers a client writes for
  // itself — so nothing in the platform may authenticate, authorize, scope, or
  // route on them, and an older client that sends neither is attributed by
  // omission. `app.installation.id` is the key desktop telemetry already
  // carries, so a desktop record and the server span it produced join on it.
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.AppClientVersion,
  // ISS-8748: the internal database user the request authenticated as. The
  // pinned OTel key rather than an `app.user.*` twin, and deliberately NOT
  // added to the App group — the desktop lane has no authenticated request to
  // attribute, and widening a schema nothing emits to is how an identity
  // attribute reaches a producer nobody reviewed for it.
  TelemetryAttribute.UserId,
  TelemetryAttribute.AppErrorSource,
  TelemetryAttribute.ArtifactType,
  TelemetryAttribute.ArtifactStatus,
  // ISS-7227: the client-generated sync batch id the request body carried. The
  // SAME key the desktop sync lane already emits, not an api-side twin — a
  // per-side spelling is what leaves the two halves of a failed sync
  // unjoinable, which is the whole defect. Read under the ingest schema's UUID
  // constraint, so a body with no readable id is attributed by omission.
  TelemetryAttribute.SyncBatchId,
] as const;

/** GenAI attributes allowed by the gen_ai schema. */
export const GenAiTelemetryAttributes = [
  TelemetryAttribute.GenAiUsageInputTokens,
  TelemetryAttribute.GenAiUsageOutputTokens,
  TelemetryAttribute.GenAiRequestModel,
  TelemetryAttribute.GenAiResponseId,
  TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
  TelemetryAttribute.GenAiUsageCacheReadInputTokens,
  TelemetryAttribute.GenAiCostUsage,
  TelemetryAttribute.GenAiOperationName,
] as const;

/** Permission-decision attributes allowed by the permission schema. */
export const PermissionTelemetryAttributes = [
  TelemetryAttribute.GenAiPermissionDecision,
  TelemetryAttribute.GenAiPermissionSource,
] as const;

/**
 * Every attribute the sync schema admits — the inventory a consumer reads to
 * learn what may appear on a `sync.batch` record, kept equal to
 * `SyncTelemetrySchema`'s own key set by the parity test in
 * `__tests__/sync.test.ts`.
 *
 * These arrays are per-SCHEMA inventories, not per-owner ledgers, so an
 * attribute belongs to as many of them as there are schemas that admit it.
 * `app.organization.id` and `app.operating_mode` are declared and OWNED by the
 * App group above and repeat here for the same reason they repeat in
 * `ApiSpanTelemetryAttributes`: the span schema admits the org too, and listing
 * it there is what makes that group answer "what can a span carry".
 */
export const SyncTelemetryAttributes = [
  TelemetryAttribute.SyncEvent,
  TelemetryAttribute.SyncOutcome,
  TelemetryAttribute.SyncPayloadBytes,
  TelemetryAttribute.SyncLatencyMs,
  TelemetryAttribute.SyncReason,
  TelemetryAttribute.SyncLane,
  TelemetryAttribute.SyncDeadLetteredCount,
  TelemetryAttribute.SyncBatchId,
  TelemetryAttribute.SyncSessionCount,
  TelemetryAttribute.SyncAttempt,
  TelemetryAttribute.SyncPayloadShaping,
  TelemetryAttribute.SyncTilingStrippedCount,
  TelemetryAttribute.SyncFreshestSessionLagMs,
  // ISS-7220: the tenant a batch belongs to, and the mode that makes an ABSENT
  // org readable as "not yet attributed" rather than "no tenant exists".
  TelemetryAttribute.AppOrganizationId,
  TelemetryAttribute.AppOperatingMode,
] as const;

/** Desktop IPC perf wide-event attributes allowed by the ipc schema (FEA-1997). */
export const IpcTelemetryAttributes = [
  TelemetryAttribute.IpcOperation,
  TelemetryAttribute.DurationMs,
  TelemetryAttribute.IpcMatchedCount,
  TelemetryAttribute.IpcPayloadBytes,
  TelemetryAttribute.IpcQueryExecution,
  TelemetryAttribute.IpcQueryRefusal,
  TelemetryAttribute.IpcQuerySource,
  TelemetryAttribute.IpcResultCount,
  TelemetryAttribute.IpcScannedCount,
  TelemetryAttribute.IpcSessionCount,
  TelemetryAttribute.ErrorType,
] as const;

/** Attributes sourced from the pinned OpenTelemetry semantic conventions. */
export const OtelTelemetryAttributes = [
  TelemetryAttribute.ServiceName,
  TelemetryAttribute.ServiceVersion,
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.DeviceId,
  TelemetryAttribute.UserId,
  TelemetryAttribute.DeploymentEnvironmentName,
  TelemetryAttribute.ExceptionType,
  TelemetryAttribute.ExceptionMessage,
  TelemetryAttribute.ExceptionStacktrace,
  TelemetryAttribute.HttpRequestMethod,
  TelemetryAttribute.HttpResponseStatusCode,
  TelemetryAttribute.UrlPath,
  TelemetryAttribute.CodeFunctionName,
  TelemetryAttribute.CodeFilePath,
  TelemetryAttribute.CodeLineNumber,
  TelemetryAttribute.CodeColumnNumber,
  TelemetryAttribute.ErrorType,
  TelemetryAttribute.GenAiUsageInputTokens,
  TelemetryAttribute.GenAiUsageOutputTokens,
  TelemetryAttribute.GenAiRequestModel,
  TelemetryAttribute.GenAiResponseId,
  TelemetryAttribute.GenAiOperationName,
] as const;

/** Compatibility attributes owned by ClosedLoop until OTel parity exists. */
export const ClosedLoopCompatibilityAttribute = {
  AppOrganizationId: TelemetryAttribute.AppOrganizationId,
  AppClientVersion: TelemetryAttribute.AppClientVersion,
  AppErrorSource: TelemetryAttribute.AppErrorSource,
  ArtifactType: TelemetryAttribute.ArtifactType,
  ArtifactStatus: TelemetryAttribute.ArtifactStatus,
  AppExceptionOrigin: TelemetryAttribute.AppExceptionOrigin,
  AppBootFailureKind: TelemetryAttribute.AppBootFailureKind,
  AppBootFailureOutcome: TelemetryAttribute.AppBootFailureOutcome,
  AppOperatingMode: TelemetryAttribute.AppOperatingMode,
  AppLifecycleEvent: TelemetryAttribute.AppLifecycleEvent,
  AppAgentMonitorRuntimeStatus: TelemetryAttribute.AppAgentMonitorRuntimeStatus,
  AppTelemetryExportDroppedOversizeCount:
    TelemetryAttribute.AppTelemetryExportDroppedOversizeCount,
  AppTelemetryExportDroppedNoSessionCount:
    TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount,
  AppTelemetryExportDroppedRateLimitedCount:
    TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount,
  AppTelemetryExportDroppedCollectorUnavailableCount:
    TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount,
  AppTelemetryExportDroppedInvalidCount:
    TelemetryAttribute.AppTelemetryExportDroppedInvalidCount,
  AppTelemetryExportSentCount: TelemetryAttribute.AppTelemetryExportSentCount,
  DurationMs: TelemetryAttribute.DurationMs,
  GenAiUsageCacheCreationInputTokens:
    TelemetryAttribute.GenAiUsageCacheCreationInputTokens,
  GenAiUsageCacheReadInputTokens:
    TelemetryAttribute.GenAiUsageCacheReadInputTokens,
  SyncEvent: TelemetryAttribute.SyncEvent,
  SyncOutcome: TelemetryAttribute.SyncOutcome,
  SyncPayloadBytes: TelemetryAttribute.SyncPayloadBytes,
  SyncLatencyMs: TelemetryAttribute.SyncLatencyMs,
  SyncReason: TelemetryAttribute.SyncReason,
  SyncLane: TelemetryAttribute.SyncLane,
  SyncDeadLetteredCount: TelemetryAttribute.SyncDeadLetteredCount,
  SyncBatchId: TelemetryAttribute.SyncBatchId,
  SyncSessionCount: TelemetryAttribute.SyncSessionCount,
  SyncAttempt: TelemetryAttribute.SyncAttempt,
  SyncPayloadShaping: TelemetryAttribute.SyncPayloadShaping,
  SyncTilingStrippedCount: TelemetryAttribute.SyncTilingStrippedCount,
  SyncFreshestSessionLagMs: TelemetryAttribute.SyncFreshestSessionLagMs,
  GenAiCostUsage: TelemetryAttribute.GenAiCostUsage,
  GenAiPermissionDecision: TelemetryAttribute.GenAiPermissionDecision,
  GenAiPermissionSource: TelemetryAttribute.GenAiPermissionSource,
  HarnessName: TelemetryAttribute.HarnessName,
  IpcOperation: TelemetryAttribute.IpcOperation,
  IpcMatchedCount: TelemetryAttribute.IpcMatchedCount,
  IpcPayloadBytes: TelemetryAttribute.IpcPayloadBytes,
  IpcQueryExecution: TelemetryAttribute.IpcQueryExecution,
  IpcQueryRefusal: TelemetryAttribute.IpcQueryRefusal,
  IpcQuerySource: TelemetryAttribute.IpcQuerySource,
  IpcResultCount: TelemetryAttribute.IpcResultCount,
  IpcScannedCount: TelemetryAttribute.IpcScannedCount,
  IpcSessionCount: TelemetryAttribute.IpcSessionCount,
  ImportEvent: TelemetryAttribute.ImportEvent,
  ImportOutcome: TelemetryAttribute.ImportOutcome,
  ImportGroupLabel: TelemetryAttribute.ImportGroupLabel,
  ImportGroupFailedCount: TelemetryAttribute.ImportGroupFailedCount,
  ImportSessionsIncomplete: TelemetryAttribute.ImportSessionsIncomplete,
  ImportSessionsPendingRevision:
    TelemetryAttribute.ImportSessionsPendingRevision,
  ImportSourcesRemaining: TelemetryAttribute.ImportSourcesRemaining,
  ImportIngestFailure: TelemetryAttribute.ImportIngestFailure,
  ImportIngestFailedCount: TelemetryAttribute.ImportIngestFailedCount,
  ImportParseDegradedSite: TelemetryAttribute.ImportParseDegradedSite,
  ImportSourcesQuarantinedParse:
    TelemetryAttribute.ImportSourcesQuarantinedParse,
  ImportSourcesQuarantinedImport:
    TelemetryAttribute.ImportSourcesQuarantinedImport,
  AuthOutcome: TelemetryAttribute.AuthOutcome,
  AuthReason: TelemetryAttribute.AuthReason,
  OnboardingStep: TelemetryAttribute.OnboardingStep,
  OnboardingEvent: TelemetryAttribute.OnboardingEvent,
  OnboardingConsentLevel: TelemetryAttribute.OnboardingConsentLevel,
  OnboardingAnalyticsAction: TelemetryAttribute.OnboardingAnalyticsAction,
  OnboardingAnalyticsReason: TelemetryAttribute.OnboardingAnalyticsReason,
  OnboardingAnalyticsOriginalEvent:
    TelemetryAttribute.OnboardingAnalyticsOriginalEvent,
  OnboardingAnalyticsStep: TelemetryAttribute.OnboardingAnalyticsStep,
  OnboardingAnalyticsFlowId: TelemetryAttribute.OnboardingAnalyticsFlowId,
  UpdateEvent: TelemetryAttribute.UpdateEvent,
  UpdateFromVersion: TelemetryAttribute.UpdateFromVersion,
  UpdateToVersion: TelemetryAttribute.UpdateToVersion,
  UpdateFailureReason: TelemetryAttribute.UpdateFailureReason,
  UpdateBootAttempts: TelemetryAttribute.UpdateBootAttempts,
  UpdateCurrentVersionAgeDays: TelemetryAttribute.UpdateCurrentVersionAgeDays,
  DeadEndTreatment: TelemetryAttribute.DeadEndTreatment,
  DeadEndPhase: TelemetryAttribute.DeadEndPhase,
  DeadEndState: TelemetryAttribute.DeadEndState,
  DeadEndReason: TelemetryAttribute.DeadEndReason,
  DeadEndRetryOffered: TelemetryAttribute.DeadEndRetryOffered,
  DeadEndRetryAttempt: TelemetryAttribute.DeadEndRetryAttempt,
  DeadEndRetryOutcome: TelemetryAttribute.DeadEndRetryOutcome,
  RoutineId: TelemetryAttribute.RoutineId,
  RoutineEvent: TelemetryAttribute.RoutineEvent,
  RoutineTrigger: TelemetryAttribute.RoutineTrigger,
  RoutineOutcome: TelemetryAttribute.RoutineOutcome,
  RoutineFailureReason: TelemetryAttribute.RoutineFailureReason,
  RoutineStepIndex: TelemetryAttribute.RoutineStepIndex,
  AuditEvent: TelemetryAttribute.AuditEvent,
  AuditActorKind: TelemetryAttribute.AuditActorKind,
  AuditDecision: TelemetryAttribute.AuditDecision,
} as const;

/** Literal union of ClosedLoop compatibility telemetry attributes. */
export type ClosedLoopCompatibilityAttribute =
  (typeof ClosedLoopCompatibilityAttribute)[keyof typeof ClosedLoopCompatibilityAttribute];

/** Attribute ownership lookup used by schema and compatibility tests. */
export const TelemetryAttributeOwnershipByName = {
  [TelemetryAttribute.ServiceName]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ServiceVersion]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppInstallationId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppClientVersion]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeviceId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppOrganizationId]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UserId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.DeploymentEnvironmentName]:
    TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionType]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionMessage]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ExceptionStacktrace]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppExceptionOrigin]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppBootFailureKind]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppBootFailureOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppOperatingMode]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppLifecycleEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppAgentMonitorRuntimeStatus]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AppTelemetryExportSentCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.HttpRequestMethod]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.HttpResponseStatusCode]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.UrlPath]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.DurationMs]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.CodeFunctionName]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeFilePath]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeLineNumber]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.CodeColumnNumber]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.ErrorType]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.AppErrorSource]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ArtifactType]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ArtifactStatus]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiUsageInputTokens]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiUsageOutputTokens]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiRequestModel]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiResponseId]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiOperationName]: TelemetryAttributeOwnership.Otel,
  [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiUsageCacheReadInputTokens]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncPayloadBytes]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncLatencyMs]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncLane]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncDeadLetteredCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncBatchId]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncSessionCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncAttempt]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncPayloadShaping]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncTilingStrippedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.SyncFreshestSessionLagMs]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiCostUsage]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiPermissionDecision]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.GenAiPermissionSource]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.HarnessName]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcOperation]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcMatchedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcPayloadBytes]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcQueryExecution]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcQueryRefusal]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcQuerySource]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcResultCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcScannedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.IpcSessionCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportGroupLabel]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportGroupFailedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportSessionsIncomplete]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportSessionsPendingRevision]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportSourcesRemaining]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportIngestFailure]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportIngestFailedCount]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportParseDegradedSite]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportSourcesQuarantinedParse]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.ImportSourcesQuarantinedImport]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AuthOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AuthReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingStep]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingConsentLevel]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingAnalyticsAction]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingAnalyticsReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingAnalyticsStep]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.OnboardingAnalyticsFlowId]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateFromVersion]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateToVersion]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateFailureReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateBootAttempts]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.UpdateCurrentVersionAgeDays]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndTreatment]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndPhase]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndState]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndRetryOffered]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndRetryAttempt]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.DeadEndRetryOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineId]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineTrigger]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineOutcome]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineFailureReason]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.RoutineStepIndex]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AuditEvent]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AuditActorKind]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
  [TelemetryAttribute.AuditDecision]:
    TelemetryAttributeOwnership.ClosedLoopCompatibility,
} as const satisfies Record<
  TelemetryAttributeName,
  TelemetryAttributeOwnership
>;

/** Deprecated code attribute aliases accepted only by compatibility checks. */
export const DeprecatedCodeTelemetryAttributes = {
  CodeFunction: "code.function",
  CodeFilepath: "code.filepath",
  CodeLineno: "code.lineno",
  CodeColumn: "code.column",
  CodeNamespace: "code.namespace",
} as const;

/** Literal union of deprecated code attribute aliases. */
export type DeprecatedCodeTelemetryAttribute =
  (typeof DeprecatedCodeTelemetryAttributes)[keyof typeof DeprecatedCodeTelemetryAttributes];

/**
 * Canonical `service.name` values under the PRD-159 Stage 7 `cl-` service-tag
 * rename. Datadog dashboards, SLOs, and monitors key off these strings, so a
 * producer imports the value rather than re-declaring the literal. A member
 * exists once its producer adopts it (ISS-6332 brought desktop over); the
 * services still emitting their pre-rename tag are deliberately absent.
 */
export const TelemetryServiceName = {
  Desktop: "cl-desktop",
} as const;

/** Literal union of canonical service names. */
export type TelemetryServiceName =
  (typeof TelemetryServiceName)[keyof typeof TelemetryServiceName];
